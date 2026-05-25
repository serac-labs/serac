interface ImportMetaEnv {
  readonly VITE_SNOW_CODE_SERVER_HOST: string
  readonly VITE_SNOW_CODE_SERVER_PORT: string
  readonly VITE_SERAC_HOSTED: string
  // Legacy alias for VITE_SERAC_HOSTED, kept for backward compatibility.
  readonly VITE_SNOW_FLOW_HOSTED: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
