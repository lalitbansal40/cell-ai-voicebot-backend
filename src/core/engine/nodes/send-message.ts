import { FLOW_LIMITS } from '../../../config/limits';
import type { NodeHandler, NodeRuntime } from '../runtime';
import type { QueuedMessage } from '../types';

const queue = (rt: NodeRuntime, message: QueuedMessage, preview: string) => {
  if (rt.state.outcome.messages.length >= FLOW_LIMITS.messagesPerRunMax) {
    rt.note(
      message.nodeId,
      `Message not queued: at most ${String(FLOW_LIMITS.messagesPerRunMax)} per call`,
    );
    return;
  }
  rt.state.outcome.messages.push(message);
  rt.push({
    type: 'message_queued',
    nodeId: message.nodeId,
    channel: message.channel,
    preview: preview.slice(0, 80),
  });
};

/** Queues an SMS sent after the call (Phase 10 sends it). */
export const sendSmsNode: NodeHandler<'send_sms'> = {
  enter: (node, rt) => {
    const text = rt.render(node.config.text, node.id);
    queue(
      rt,
      {
        channel: 'sms',
        nodeId: node.id,
        text,
        templateName: null,
        language: null,
        params: [],
        dltTemplateId: node.config.dltTemplateId,
        queuedAt: rt.ctx.now().toISOString(),
      },
      text,
    );
    return Promise.resolve({ exit: 'next' });
  },
};

/** Queues a WhatsApp template sent after the call (Phase 10 sends it). */
export const sendWhatsappNode: NodeHandler<'send_whatsapp'> = {
  enter: (node, rt) => {
    const params = node.config.params.map((p) => rt.render(p, node.id));
    queue(
      rt,
      {
        channel: 'whatsapp',
        nodeId: node.id,
        text: null,
        templateName: node.config.templateName,
        language: node.config.language,
        params,
        dltTemplateId: null,
        queuedAt: rt.ctx.now().toISOString(),
      },
      `${node.config.templateName}(${params.join(', ')})`,
    );
    return Promise.resolve({ exit: 'next' });
  },
};
