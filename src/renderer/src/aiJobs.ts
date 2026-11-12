export type AiJobType = 'summary' | 'lint'

export interface AiNotice {
  type: AiJobType
  error?: string
  changed?: number
}
