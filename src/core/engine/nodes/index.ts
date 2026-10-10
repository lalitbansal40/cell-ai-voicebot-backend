import type { NodeType } from '../../../db/models/flow.model';
import type { NodeHandler } from '../runtime';

import { aiAgentNode } from './ai-agent';
import { apiRequestNode } from './api-request';
import { conditionRouterNode } from './condition-router';
import { gatherDtmfNode } from './gather-dtmf';
import { gatherSpeechNode } from './gather-speech';
import { hangupNode } from './hangup';
import { playAudioNode } from './play-audio';
import { sendSmsNode, sendWhatsappNode } from './send-message';
import { setDispositionNode } from './set-disposition';
import { setVariableNode } from './set-variable';
import { speakNode } from './speak';
import { startNode } from './start';
import { transferNode } from './transfer';
import { waitNode } from './wait';

/** One handler per node type — no big switch (AutoChatix gap). */
export const NODE_HANDLERS: { [T in NodeType]: NodeHandler<T> } = {
  start: startNode,
  speak: speakNode,
  play_audio: playAudioNode,
  gather_dtmf: gatherDtmfNode,
  gather_speech: gatherSpeechNode,
  ai_agent: aiAgentNode,
  api_request: apiRequestNode,
  condition_router: conditionRouterNode,
  set_variable: setVariableNode,
  set_disposition: setDispositionNode,
  transfer_to_agent: transferNode,
  send_sms: sendSmsNode,
  send_whatsapp: sendWhatsappNode,
  wait: waitNode,
  hangup: hangupNode,
};
