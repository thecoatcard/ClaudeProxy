export interface AnthropicErrorResponse {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

export function transformError(err: any): AnthropicErrorResponse {
  const status = err.status || 500;
  const message = err.message || "An unexpected error occurred.";
  const data = err.data?.error || {};

  // Gemini Safety Blocks
  if (status === 400 && (message.includes('SAFETY') || message.includes('blocked'))) {
    return {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Gemini Safety Block: ${message}`
      }
    };
  }

  // Rate Limits
  if (status === 429) {
    return {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "Gemini rate limit exceeded. Rotating keys..."
      }
    };
  }

  // Overloaded / Capacity
  if (status === 503 || status === 504 || status === 502 || message.includes('overloaded') || message.includes('capacity')) {
    return {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: "Gemini is currently overloaded. Please try again in a few seconds."
      }
    };
  }

  // Authentication
  if (status === 401 || status === 403) {
    return {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: "Gemini API key is invalid or revoked."
      }
    };
  }

  // Default API Error
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message: message
    }
  };
}
