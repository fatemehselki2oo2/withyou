/**
 * Voice input is an explicit companion action, not a passive sensor.
 * Importing this module never requests permission; the caller must invoke the
 * function from a user gesture such as the “Talk to WithYou” button.
 */
export function canUseVoiceInput(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined'
}

export function requestVoiceInputStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: true })
}
