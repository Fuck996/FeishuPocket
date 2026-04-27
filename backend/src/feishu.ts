export interface FeishuCardPayload {
  title: string;
  lines: string[];
}

export async function sendFeishuCard(webhookUrl: string | undefined, payload: FeishuCardPayload): Promise<void> {
  if (!webhookUrl) {
    return;
  }

  const card = {
    msg_type: 'interactive',
    card: {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: payload.title
        }
      },
      elements: payload.lines.map((line) => ({
        tag: 'markdown',
        content: line
      }))
    }
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(card)
  });
}
