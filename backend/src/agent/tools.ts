export interface ToolSchema {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    name: 'book_meeting',
    description:
      'Reserve one of the slots listed in your instructions. Call this only after the prospect ' +
      'has verbally agreed to a specific time. Confirm the time out loud afterwards.',
    parameters: {
      type: 'object',
      properties: { slot_id: { type: 'string', description: 'The id of a slot from your instructions.' } },
      required: ['slot_id'],
    },
  },
  {
    type: 'function',
    name: 'save_qualification',
    description:
      'Record what you have learned about the prospect. Call this as soon as you learn anything, ' +
      'not at the end of the call. Send only the fields you actually learned.',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string' },
        timing: { type: 'string' },
        authority: { type: 'string' },
        current_solution: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'End the call. Call this after saying goodbye, or after a second refusal.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
]
