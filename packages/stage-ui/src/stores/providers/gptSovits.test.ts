import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { describe, expect, it } from 'vitest'

import { buildGptSoVitsProvider, pickGptSoVitsRequestOptions } from './gptSovits'

describe('gpt-SoVITS provider', () => {
  it('forwards only bridge-supported speech options', () => {
    // ROOT CAUSE:
    //
    // The speech generator serializes almost every key returned by a provider.
    // Spreading persisted settings would therefore leak baseUrl, apiKey, and UI
    // state into the OpenAI-compatible request body.
    //
    // The provider now projects configuration through a fixed allow-list.
    expect(pickGptSoVitsRequestOptions({
      apiKey: 'secret',
      baseUrl: 'http://127.0.0.1:9000/v1/',
      speed: 1.25,
      textLang: 'ja',
      textSplitMethod: '',
      voice_settings: { open: true },
    })).toEqual({
      speed: 1.25,
      textLang: 'ja',
    })
  })

  it('normalizes the bridge URL and lets per-call settings win', async () => {
    const metadata = buildGptSoVitsProvider(() => undefined)
    const provider = await metadata.createProvider({
      baseUrl: ' http://127.0.0.1:9000/v1 ',
      model: 'gpt-sovits-tts',
      speed: 1,
    }) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>

    expect(provider.speech('', { speed: 1.5 })).toEqual({
      baseURL: 'http://127.0.0.1:9000/v1/',
      model: 'gpt-sovits-tts',
      speed: 1.5,
    })
  })
})
