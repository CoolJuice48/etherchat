// Per-ether and per-account limits. Durations are in milliseconds.

export interface Limits {
  maxMembers: number
  maxFilesPerEther: number
  maxEtherBytes: number
  maxVersionsPerFile: number
  maxPostBytes: number
  maxEthersPerAccount: number
  inviteTtlMs: number
  maxScheduleAheadMs: number
}

const day = 24 * 60 * 60 * 1000

export function defaultLimits(): Limits {
  return {
    maxMembers: 4,
    maxFilesPerEther: 2000,
    maxEtherBytes: 1 << 30,
    maxVersionsPerFile: 50,
    maxPostBytes: 32 << 10,
    maxEthersPerAccount: 20,
    inviteTtlMs: 7 * day,
    maxScheduleAheadMs: 30 * day,
  }
}
