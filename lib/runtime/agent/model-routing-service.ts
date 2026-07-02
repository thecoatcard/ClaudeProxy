import { getModelMapping, type ModelRoute } from '@/lib/model-router';

type RuntimeRequestBody = {
  thinking?: {
    type?: string;
  };
};

export class RuntimeModelRouter {
  route(model: string, body: RuntimeRequestBody, ownerId: string): Promise<ModelRoute> {
    return getModelMapping(model, {
      thinkingEnabled: !!(body?.thinking && body.thinking.type === 'enabled'),
      requestBody: body,
      userId: ownerId,
    });
  }
}
