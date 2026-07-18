/**
 * Minimal OSC 1.0 message encoder for preview playback and TD replay.
 *
 * When the event carries a `types` tag string (recorded by osc-tap), each
 * arg is encoded by its tag, so f/d/i/h keep their recorded type and a
 * genuine string that looks like "<impulse>" or "#rrggbbaa" stays a string.
 * Args whose value no longer fits the tag (curve edits) and clips recorded
 * before `types` existed fall back to guessing:
 *   integer number → i, other number → f, string → s,
 *   "#rrggbbaa" → r (color), "<impulse>" → I, bool → T/F, null → N.
 */

function pad4(b: Buffer): Buffer {
  return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
}

const COLOR_RE = /^#([0-9a-f]{8})$/i
const INT64_RE = /^-?\d+$/
const INT64_MAX = 0x7fffffffffffffffn
const INT64_MIN = -0x8000000000000000n

/**
 * Encode one arg by its recorded tag. Returns false to fall back to
 * guessing — for values edited out of their tag's range, and for tags
 * (T/F/I/N/r) where guessing already produces the recorded bytes.
 */
function encodeByTag(tag: string, arg: unknown, emit: (t: string, b?: Buffer) => void): boolean {
  switch (tag) {
    case 'i': {
      if (typeof arg !== 'number' || !Number.isFinite(arg)) return false
      // Curve edits can drag an int arg to a fraction; keep the curve int.
      const v = Math.round(arg)
      if (Math.abs(v) > 0x7fffffff) return false
      const b = Buffer.alloc(4)
      b.writeInt32BE(v)
      emit('i', b)
      return true
    }
    case 'f': {
      if (typeof arg !== 'number') return false
      const b = Buffer.alloc(4)
      b.writeFloatBE(arg)
      emit('f', b)
      return true
    }
    case 'd': {
      if (typeof arg !== 'number') return false
      const b = Buffer.alloc(8)
      b.writeDoubleBE(arg)
      emit('d', b)
      return true
    }
    case 'h': {
      // Recorded as a number, or a decimal string when > 2^53.
      let v: bigint
      if (typeof arg === 'number' && Number.isFinite(arg)) v = BigInt(Math.round(arg))
      else if (typeof arg === 'string' && INT64_RE.test(arg)) v = BigInt(arg)
      else return false
      if (v > INT64_MAX || v < INT64_MIN) return false
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(v)
      emit('h', b)
      return true
    }
    case 's': {
      if (typeof arg !== 'string') return false
      emit('s', pad4(Buffer.from(arg + '\0')))
      return true
    }
    default:
      return false
  }
}

export function encodeOscMessage(addr: string, args: unknown[], types?: string): Buffer {
  let tags = ','
  const data: Buffer[] = []
  const emit = (t: string, b?: Buffer): void => {
    tags += t
    if (b) data.push(b)
  }
  // A length mismatch means the tags don't describe these args; ignore them.
  const tagged = types !== undefined && types.length === args.length ? types : null
  args.forEach((arg, n) => {
    if (tagged && encodeByTag(tagged[n], arg, emit)) return
    if (typeof arg === 'boolean') {
      emit(arg ? 'T' : 'F')
    } else if (arg === null) {
      emit('N')
    } else if (typeof arg === 'number') {
      if (Number.isInteger(arg) && Math.abs(arg) <= 0x7fffffff) {
        const b = Buffer.alloc(4)
        b.writeInt32BE(arg)
        emit('i', b)
      } else {
        const b = Buffer.alloc(4)
        b.writeFloatBE(arg)
        emit('f', b)
      }
    } else if (typeof arg === 'string') {
      if (arg === '<impulse>') {
        emit('I')
      } else if (COLOR_RE.test(arg)) {
        emit('r', Buffer.from(COLOR_RE.exec(arg)![1], 'hex'))
      } else {
        emit('s', pad4(Buffer.from(arg + '\0')))
      }
    } else {
      emit('s', pad4(Buffer.from(String(arg) + '\0')))
    }
  })
  return Buffer.concat([pad4(Buffer.from(addr + '\0')), pad4(Buffer.from(tags + '\0')), ...data])
}
