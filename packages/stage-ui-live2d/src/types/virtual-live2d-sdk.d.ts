declare module 'virtual:live2d-sdk/cores' {
  export interface ProvisionedLive2DCore {
    available: boolean
    url: string
    sri: string
    expectedGlobal: string
  }

  export const cubism2Core: ProvisionedLive2DCore
}
