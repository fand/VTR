/**
 * Minimal OSC 1.0 message encoder for preview playback.
 * Maps recorded JSON args back to OSC types:
 *   integer number → i, other number → f, string → s,
 *   "#rrggbbaa" → r (color), "<impulse>" → I, bool → T/F, null → N.
 *
 * KNOWN-LOSSY: the recorded JSONL carries no OSC type tags, so this
 * re-encode guesses. Non-integer numbers and ints > 2^31 become f32
 * (double precision lost); a genuine STRING equal to "<impulse>" or
 * matching "#rrggbbaa" is re-encoded as impulse/color. Affects preview
 * only — export copies the JSONL unchanged. The real fix is recording
 * type tags in osc-tap's JSONL and using them here.
 */

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

const COLOR_RE = /^#([0-9a-f]{8})$/i

export function encodeOscMessage(addr: string, args: unknown[]): Buffer {
  let tags = ','
  const data: Buffer[] = []
  for (const arg of args) {
    if (typeof arg === 'boolean') {
      tags += arg ? 'T' : 'F'
    } else if (arg === null) {
      tags += 'N'
    } else if (typeof arg === 'number') {
      if (Number.isInteger(arg) && Math.abs(arg) <= 0x7fffffff) {
        tags += 'i'
        const b = Buffer.alloc(4)
        b.writeInt32BE(arg)
        data.push(b)
      } else {
        tags += 'f'
        const b = Buffer.alloc(4)
        b.writeFloatBE(arg)
        data.push(b)
      }
    } else if (typeof arg === 'string') {
      if (arg === '<impulse>') {
        tags += 'I'
      } else if (COLOR_RE.test(arg)) {
        tags += 'r'
        data.push(Buffer.from(COLOR_RE.exec(arg)![1], 'hex'))
      } else {
        tags += 's'
        data.push(pad4(Buffer.from(arg + '\0')))
      }
    } else {
      tags += 's'
      data.push(pad4(Buffer.from(String(arg) + '\0')))
    }
  }
  return Buffer.concat([pad4(Buffer.from(addr + '\0')), pad4(Buffer.from(tags + '\0')), ...data])
}
