// A File from `dataTransfer.files` on iOS Safari is backed by a temporary
// drag-session file. Once the drop event returns, the system may release it,
// and any later read yields zero bytes. `fetch` then sends a multipart body
// with Content-Length: 0 and the server fails with "missing final boundary".
// So we start reading every file inside the drop handler and hand the upload
// queue in-memory copies instead.
export function snapshotDroppedFiles(files: File[]): Promise<File[]> {
  return Promise.all(files.map(async (file) => {
    const bytes = await file.arrayBuffer()
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified })
  }))
}
