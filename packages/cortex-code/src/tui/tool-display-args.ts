const MAX_EDIT_PREVIEW_CHARS = 120;

function truncatePreview(text: string, maxChars = MAX_EDIT_PREVIEW_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 3) + '...';
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export function buildToolDisplayArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case 'Write': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      const content = typeof args['content'] === 'string' ? args['content'] : '';

      return {
        file_path: filePath,
        content_bytes: Buffer.byteLength(content, 'utf8'),
        content_lines: countLines(content),
      };
    }

    case 'Edit': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : '';
      const newString = typeof args['new_string'] === 'string' ? args['new_string'] : '';

      return {
        file_path: filePath,
        old_string: truncatePreview(oldString),
        old_string_bytes: Buffer.byteLength(oldString, 'utf8'),
        new_string_bytes: Buffer.byteLength(newString, 'utf8'),
        replace_all: Boolean(args['replace_all']),
      };
    }

    default:
      return args;
  }
}

export function summarizeToolStartArgs(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    toolCallId,
    toolName,
  };

  switch (toolName) {
    case 'Write': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      summary['filePath'] = filePath;
      summary['contentBytes'] = Buffer.byteLength(content, 'utf8');
      summary['contentLines'] = countLines(content);
      break;
    }

    case 'Edit': {
      const filePath = String(args['file_path'] ?? args['path'] ?? '');
      const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : '';
      const newString = typeof args['new_string'] === 'string' ? args['new_string'] : '';
      summary['filePath'] = filePath;
      summary['oldStringBytes'] = Buffer.byteLength(oldString, 'utf8');
      summary['newStringBytes'] = Buffer.byteLength(newString, 'utf8');
      summary['replaceAll'] = Boolean(args['replace_all']);
      break;
    }

    default:
      summary['argKeys'] = Object.keys(args);
      break;
  }

  return summary;
}
