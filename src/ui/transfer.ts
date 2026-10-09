import { extname, join, normalize } from '../core/path'
import { importZip, isProbablyBinary } from '../core/zip'

export interface UploadResult {
  files: Record<string, string>
  dirs: string[]
  skipped: string[]
}

/**
 * Reads files chosen by the user (or dropped) into text files under `targetDir`.
 * Folder uploads keep their structure; .zip archives are extracted; binaries are skipped.
 */
export async function readUploads(targetDir: string, files: Iterable<File>): Promise<UploadResult> {
  const result: UploadResult = { files: {}, dirs: [], skipped: [] }
  const decoder = new TextDecoder()
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (extname(file.name) === '.zip') {
      const unzipped = importZip(bytes)
      for (const [path, content] of Object.entries(unzipped.files)) result.files[join(targetDir, path)] = content
      result.dirs.push(...unzipped.dirs.map((d) => join(targetDir, d)))
      result.skipped.push(...unzipped.skipped)
    } else if (isProbablyBinary(bytes)) {
      result.skipped.push(relative)
    } else {
      result.files[join(targetDir, normalize(relative))] = decoder.decode(bytes)
    }
  }
  return result
}

export function downloadBlob(name: string, data: BlobPart, type = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Opens the native file picker. Resolves with an empty list when cancelled. */
export function pickFiles(options: { directory?: boolean; accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple ?? true
    if (options.accept) input.accept = options.accept
    if (options.directory) input.setAttribute('webkitdirectory', '')
    input.addEventListener('change', () => resolve([...(input.files ?? [])]))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
}
