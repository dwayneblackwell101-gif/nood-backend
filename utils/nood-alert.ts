import { Alert } from 'react-native';

export type NoodAlertButton = {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
};

type NoodAlertHandler = (
  title: string,
  message?: string,
  buttons?: NoodAlertButton[]
) => void;

let alertHandler: NoodAlertHandler | null = null;

export function registerNoodAlert(handler: NoodAlertHandler | null) {
  alertHandler = handler;
}

export function noodAlert(title: string, message?: string, buttons?: NoodAlertButton[]) {
  if (alertHandler) {
    alertHandler(title, message, buttons);
    return;
  }

  Alert.alert(title, message || '', buttons);
}