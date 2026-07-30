import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'fs'

let tmpSeq = 0

/** Crash-safe file replace. Unique tmp name: a fixed suffix would let two
 *  instances clobber each other's in-flight write. fsync before rename so a
 *  crash never publishes an empty or truncated file. */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
