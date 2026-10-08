/** Realtime API event names (GA, verified 2026-10-08 — developers.openai.com API reference). */
export const ClientEvent = {
  SessionUpdate: 'session.update',
  InputAudioAppend: 'input_audio_buffer.append',
  InputAudioCommit: 'input_audio_buffer.commit',
  InputAudioClear: 'input_audio_buffer.clear',
  ResponseCreate: 'response.create',
  ResponseCancel: 'response.cancel',
  ItemCreate: 'conversation.item.create',
  ItemTruncate: 'conversation.item.truncate',
} as const;

export const ServerEvent = {
  Error: 'error',
  SessionCreated: 'session.created',
  SessionUpdated: 'session.updated',
  SpeechStarted: 'input_audio_buffer.speech_started',
  SpeechStopped: 'input_audio_buffer.speech_stopped',
  InputTranscriptCompleted: 'conversation.item.input_audio_transcription.completed',
  ResponseCreated: 'response.created',
  AudioDelta: 'response.output_audio.delta',
  AudioDone: 'response.output_audio.done',
  AudioTranscriptDelta: 'response.output_audio_transcript.delta',
  AudioTranscriptDone: 'response.output_audio_transcript.done',
  FunctionCallArgumentsDone: 'response.function_call_arguments.done',
  ResponseDone: 'response.done',
} as const;
