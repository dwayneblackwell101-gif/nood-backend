import { Platform } from 'react-native';

export async function copyToClipboard(value: string): Promise<boolean> {
  const text = String(value || '').trim();
  if (!text) {
    return false;
  }

  try {
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      return false;
    }

    const Clipboard = require('react-native').Clipboard;
    if (Clipboard?.setString) {
      Clipboard.setString(text);
      return true;
    }
  } catch (error) {
    console.log('Clipboard copy failed:', error);
  }

  return false;
}