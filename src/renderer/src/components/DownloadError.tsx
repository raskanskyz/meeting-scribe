interface Props {
  error: string
  details?: string
}

export default function DownloadError({ error, details }: Props) {
  return (
    <div className="warn-banner">
      Download failed: {error}
      {details && <details><summary>Error details</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{details}</pre></details>}
    </div>
  )
}
