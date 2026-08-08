import type { JSONObject, ModelSettings } from 'pixi-live2d-display'

import type { Live2DRuntime } from '../utils/live2d-runtime'

import JSZip from 'jszip'

import { errorMessageFrom } from '@moeru/std'

import { live2DGenerationLoaders, selectLive2DSettings } from '../generations/loader'
import { decodeZipFileName } from '../utils/decode-zip-filename'

let configuredRuntime: Live2DRuntime | undefined

export function shouldIgnoreLive2DArchiveEntry(filePath: string): boolean {
  return filePath
    .split('/')
    .some(segment => segment === '__MACOSX' || segment.startsWith('._'))
}

export function isSettingsFile(file: string): boolean {
  return !shouldIgnoreLive2DArchiveEntry(file)
    && !file.endsWith('items_pinned_to_model.json')
    && live2DGenerationLoaders.some(loader => loader.isSettingsPath(file))
}

export function isMocFile(file: string): boolean {
  return file.endsWith('.moc3') || file.endsWith('.moc')
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop()!
}

/** Normalize resolved Live2D resource paths back to decoded archive paths. */
function normalizeLive2DArchivePath(path: string): string {
  try {
    return decodeURI(path)
  }
  catch {
    return path
  }
}

function useArchivePathResolution(settings: ModelSettings): ModelSettings {
  const resolveURL = settings.resolveURL.bind(settings)
  settings.resolveURL = path => normalizeLive2DArchivePath(resolveURL(path))
  return settings
}

function createModelSettings(json: JSONObject, url: string): ModelSettings {
  if (!configuredRuntime)
    throw new Error('Live2D runtime has not been configured.')
  const selected = selectLive2DSettings([{ path: url, json }])
  return useArchivePathResolution(
    selected.loader.createSettings(configuredRuntime, selected.loader.sanitizeSettings(json), url),
  )
}

async function selectZipSettings(reader: JSZip) {
  const paths = Object.keys(reader.files).filter(isSettingsFile)
  const candidates = await Promise.all(paths.map(async path => ({
    path,
    json: JSON.parse(await reader.file(path)!.async('text')) as JSONObject,
  })))
  return selectLive2DSettings(candidates)
}

async function selectFileSettings(files: File[]) {
  const candidates = await Promise.all(files
    .filter(file => isSettingsFile(file.webkitRelativePath || file.name))
    .map(async file => ({
      path: file.webkitRelativePath || file.name,
      json: JSON.parse(await file.text()) as JSONObject,
      file,
    })))
  const selected = selectLive2DSettings(candidates)
  return { ...selected, file: candidates.find(candidate => candidate.path === selected.path)!.file }
}

interface Live2DModelMetadata {
  _cdiData?: unknown
  _expFiles?: Array<{ name: string, fileName: string, data: unknown }>
}

interface MetadataSource {
  path: string
  readText: () => Promise<string>
}

function isExpressionPath(path: string): boolean {
  const lowerCased = path.toLowerCase()
  return lowerCased.endsWith('.exp3.json') || lowerCased.endsWith('.exp.json')
}

function isCdiPath(path: string): boolean {
  return path.toLowerCase().endsWith('.cdi3.json')
}

function expressionNameOf(path: string): string {
  return basename(path).replace(/\.exp3?\.json$/i, '')
}

async function readOptionalJSON(source: MetadataSource): Promise<{ data: unknown } | undefined> {
  try {
    return { data: JSON.parse(await source.readText()) }
  }
  catch (error) {
    console.warn(`[Live2D] Ignoring unreadable metadata file "${source.path}":`, errorMessageFrom(error))
    return undefined
  }
}

async function collectMetadata(sources: MetadataSource[]): Promise<Live2DModelMetadata> {
  const metadata: Live2DModelMetadata = {}

  const cdiSource = sources.find(source => isCdiPath(source.path))
  if (cdiSource) {
    const parsed = await readOptionalJSON(cdiSource)
    if (parsed)
      metadata._cdiData = parsed.data
  }

  const expressions = await Promise.all(
    sources.filter(source => isExpressionPath(source.path)).map(async (source) => {
      const parsed = await readOptionalJSON(source)
      return parsed && { name: expressionNameOf(source.path), fileName: source.path, data: parsed.data }
    }),
  )
  metadata._expFiles = expressions.filter(expression => expression != null)

  return metadata
}

/** Installs AIRI's ZIP and directory policies on the selected runtime exactly once. */
export function configureLive2DLoaders(runtime: Live2DRuntime): void {
  if (configuredRuntime === runtime)
    return
  configuredRuntime = runtime

  const { FileLoader, ZipLoader } = runtime
  ZipLoader.zipReader = (data: Blob) => JSZip.loadAsync(data, { decodeFileName: decodeZipFileName })

  ZipLoader.createSettings = async (reader: JSZip) => {
    const filePaths = Object.keys(reader.files)
    const selected = await selectZipSettings(reader)
    const settings = createModelSettings(selected.json, selected.path)
    Object.assign(settings, await collectMetadata(
      filePaths
        .filter(path => !shouldIgnoreLive2DArchiveEntry(path))
        .map(path => ({ path, readText: () => reader.file(path)!.async('text') })),
    ))

    return settings
  }

  ZipLoader.readText = async (reader: JSZip, path: string) => {
    const file = reader.file(path)
    if (!file)
      throw new Error(`Cannot find file: ${path}`)
    const text = await file.async('text')
    if (!isSettingsFile(path))
      return text
    const json = JSON.parse(text) as JSONObject
    const selected = selectLive2DSettings([{ path, json }])
    return JSON.stringify(selected.loader.sanitizeSettings(json))
  }

  ZipLoader.getFilePaths = async (reader: JSZip) => {
    const paths: string[] = []
    reader.forEach((relativePath, file) => {
      if (!file.dir && !shouldIgnoreLive2DArchiveEntry(relativePath))
        paths.push(relativePath)
    })
    return paths
  }

  ZipLoader.getFiles = (reader: JSZip, paths: string[]) =>
    Promise.all(paths.map(async (path) => {
      const file = new File([await reader.file(path)!.async('blob')], basename(path))
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      return file
    }))

  const defaultReadText = FileLoader.readText
  FileLoader.createSettings = async (files: File[]) => {
    const selected = await selectFileSettings(files)
    const settings = createModelSettings(selected.json, selected.path)
    Object.assign(settings, { _objectURL: URL.createObjectURL(selected.file) })
    Object.assign(settings, await collectMetadata(
      files.map(file => ({ path: file.webkitRelativePath || file.name, readText: () => file.text() })),
    ))

    return settings
  }
  FileLoader.readText = async (file: File) => {
    const text = await defaultReadText(file)
    const path = file.webkitRelativePath || file.name
    if (!isSettingsFile(path))
      return text
    const json = JSON.parse(text) as JSONObject
    const selected = selectLive2DSettings([{ path, json }])
    return JSON.stringify(selected.loader.sanitizeSettings(json))
  }
}
