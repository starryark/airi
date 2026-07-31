import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import type { ModelInfo, ProviderMetadata, VoiceInfo } from '../providers'

import { errorMessageFrom } from '@moeru/std'

const providerId = 'gpt-sovits'
const defaultModel = 'gpt-sovits-tts'

/** Synthesis options supported by the local GPT-SoVITS bridge. */
export interface GptSoVitsRequestOptions {
  textLang?: string
  speed?: number
  topK?: number
  topP?: number
  temperature?: number
  textSplitMethod?: string
  repetitionPenalty?: number
  sampleSteps?: number
  seed?: number
  stripNarration?: boolean
}

const requestOptionKeys = [
  'textLang',
  'speed',
  'topK',
  'topP',
  'temperature',
  'textSplitMethod',
  'repetitionPenalty',
  'sampleSteps',
  'seed',
  'stripNarration',
] as const satisfies readonly (keyof GptSoVitsRequestOptions)[]

function normalizeBaseUrl(value: unknown): string {
  const baseUrl = typeof value === 'string' ? value.trim() : ''
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

/** Keeps provider credentials and settings-only fields out of speech requests. */
export function pickGptSoVitsRequestOptions(config: Record<string, unknown>): GptSoVitsRequestOptions {
  const options: GptSoVitsRequestOptions = {}

  for (const key of requestOptionKeys) {
    const value = config[key]
    if (value !== undefined && value !== null && value !== '')
      Object.assign(options, { [key]: value })
  }

  return options
}

/** Builds the provider metadata for an OpenAI-compatible local GPT-SoVITS bridge. */
export function buildGptSoVitsProvider(
  validateBaseUrl: (baseUrl: unknown) => { errors: unknown[], reason: string, valid: boolean } | null | undefined,
): ProviderMetadata {
  return {
    id: providerId,
    category: 'speech',
    tasks: ['text-to-speech'],
    nameKey: 'settings.pages.providers.provider.gpt-sovits.title',
    name: 'GPT-SoVITS (Local)',
    descriptionKey: 'settings.pages.providers.provider.gpt-sovits.description',
    description: 'github.com/RVC-Boss/GPT-SoVITS',
    icon: 'i-solar:soundwave-bold-duotone',
    requiresCredentials: false,
    defaultOptions: () => ({
      baseUrl: 'http://127.0.0.1:9000/v1/',
      model: defaultModel,
      textLang: 'auto',
      speed: 1,
      topK: 15,
      topP: 1,
      temperature: 1,
      textSplitMethod: '',
      repetitionPenalty: 1.35,
      sampleSteps: 32,
      seed: -1,
      stripNarration: true,
    }),
    createProvider: (config) => {
      const provider: SpeechProviderWithExtraOptions<string, GptSoVitsRequestOptions> = {
        speech: (model, extraOptions) => {
          // Provider instances are cached, while settings replace the persisted
          // config object. Per-call values therefore have the final precedence.
          const merged: Record<string, unknown> = { ...config, ...extraOptions }
          return {
            baseURL: normalizeBaseUrl(merged.baseUrl),
            model: model || (merged.model as string) || defaultModel,
            ...pickGptSoVitsRequestOptions(merged),
          }
        },
      }
      return provider
    },
    capabilities: {
      listModels: async (config) => {
        const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}models`)
        if (!response.ok)
          throw new Error(`Failed to fetch models: HTTP ${response.status} ${response.statusText}`)

        const body = await response.json() as { data?: { id: string, description?: string }[] }
        return (body.data ?? []).map(model => ({
          id: model.id,
          name: model.id,
          provider: providerId,
          description: model.description || '',
          contextLength: 0,
          deprecated: false,
        } satisfies ModelInfo))
      },
      listVoices: async (config) => {
        const baseUrl = normalizeBaseUrl(config.baseUrl)
        const response = await fetch(`${baseUrl}voices`)
        if (!response.ok)
          throw new Error(`Failed to fetch voices: HTTP ${response.status} ${response.statusText}`)

        const body = await response.json() as {
          voices?: Array<{
            id: string
            name: string
            description?: string
            gender?: string
            preview_url?: string
            languages?: { code: string, title: string }[]
          }>
        }
        return (body.voices ?? []).map(voice => ({
          id: voice.id,
          name: voice.name,
          provider: providerId,
          description: voice.description,
          gender: voice.gender,
          previewURL: voice.preview_url ? new URL(voice.preview_url, baseUrl).toString() : undefined,
          languages: voice.languages ?? [],
        } satisfies VoiceInfo))
      },
    },
    validators: {
      chatPingCheckAvailable: false,
      validateProviderConfig: async (config) => {
        const urlError = validateBaseUrl(config.baseUrl)
        if (urlError)
          return urlError

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 5000)
        try {
          const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}health`, { signal: controller.signal })
          if (!response.ok) {
            const reason = `GPT-SoVITS bridge unreachable: HTTP ${response.status} ${response.statusText}`
            return { errors: [new Error(reason)], reason, valid: false }
          }

          const health = await response.json() as {
            upstream?: { reachable?: boolean, url?: string }
            voices?: { count?: number }
          }
          if (health.upstream?.reachable === false) {
            const reason = `Bridge is running but GPT-SoVITS is unreachable at ${health.upstream.url ?? 'the configured upstream'}.`
            return { errors: [new Error(reason)], reason, valid: false }
          }
          if (!health.voices?.count) {
            const reason = 'No voice profiles configured. Add one to voices.yaml, then reload the bridge.'
            return { errors: [new Error(reason)], reason, valid: false }
          }
        }
        catch (error) {
          const reason = `GPT-SoVITS bridge connection failed: ${errorMessageFrom(error) ?? 'unknown error'}`
          return { errors: [error], reason, valid: false }
        }
        finally {
          clearTimeout(timeout)
        }

        return { errors: [], reason: '', valid: true }
      },
    },
  }
}
