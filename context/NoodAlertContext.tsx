import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Modal, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import NoodDialogShell, { noodDialogStyles } from '../components/NoodDialogShell';
import { registerNoodAlert, type NoodAlertButton } from '../utils/nood-alert';

type AlertConfig = {
  title: string;
  message: string;
  buttons: NoodAlertButton[];
};

type NoodAlertContextValue = {
  showAlert: (title: string, message?: string, buttons?: NoodAlertButton[]) => void;
};

const NoodAlertContext = createContext<NoodAlertContextValue | null>(null);

const webShadow = (value: string) => (Platform.OS === 'web' ? { boxShadow: value } : {});
const platformShadow = (webValue: string, nativeValue: object) =>
  Platform.OS === 'web' ? webShadow(webValue) : nativeValue;

function NoodAlertDialog({
  visible,
  config,
  onClose,
  onPressButton,
}: {
  visible: boolean;
  config: AlertConfig | null;
  onClose: () => void;
  onPressButton: (button: NoodAlertButton) => void;
}) {
  if (!config) {
    return null;
  }

  const buttons = config.buttons.length ? config.buttons : [{ text: 'OK' }];
  const useStackedButtons = buttons.length > 2;
  const useSplitButtons = buttons.length === 2 && !useStackedButtons;

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalHost}>
        <NoodDialogShell onBackdropPress={onClose} cardStyle={styles.alertCard}>
          <Text style={styles.title}>{config.title}</Text>
          {config.message ? <Text style={styles.message}>{config.message}</Text> : null}

          <View
            style={[
              styles.actions,
              useStackedButtons && styles.actionsStacked,
              useSplitButtons && styles.actionsSplit,
            ]}
          >
            {buttons.map((button, index) => {
              const style = button.style || 'default';
              const isDestructive = style === 'destructive';
              const isCancel = style === 'cancel';
              const isPrimary =
                !isDestructive &&
                !isCancel &&
                (style === 'default' || buttons.length === 1) &&
                (buttons.length === 1 || index === buttons.length - 1);

              return (
                <TouchableOpacity
                  key={`${button.text}-${index}`}
                  style={[
                    styles.actionButton,
                    useStackedButtons && styles.actionButtonStacked,
                    useSplitButtons && styles.actionButtonSplit,
                    isPrimary && styles.actionButtonPrimary,
                    isCancel && styles.actionButtonSecondary,
                    isDestructive && styles.actionButtonDanger,
                    !isPrimary && !isCancel && !isDestructive && styles.actionButtonSecondary,
                  ]}
                  activeOpacity={0.88}
                  onPress={() => onPressButton(button)}
                >
                  <Text
                    style={[
                      styles.actionText,
                      isPrimary && styles.actionTextPrimary,
                      isCancel && styles.actionTextSecondary,
                      isDestructive && styles.actionTextDanger,
                      !isPrimary && !isCancel && !isDestructive && styles.actionTextSecondary,
                    ]}
                  >
                    {button.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </NoodDialogShell>
      </View>
    </Modal>
  );
}

export function NoodAlertProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<AlertConfig | null>(null);

  const showAlert = useCallback(
    (title: string, message?: string, buttons?: NoodAlertButton[]) => {
      setConfig({
        title: String(title || 'NOOD'),
        message: String(message || ''),
        buttons: buttons?.length ? buttons : [{ text: 'OK' }],
      });
      setVisible(true);
    },
    []
  );

  useEffect(() => {
    registerNoodAlert(showAlert);
    return () => registerNoodAlert(null);
  }, [showAlert]);

  const closeAlert = useCallback(() => {
    setVisible(false);
  }, []);

  const handlePressButton = useCallback((button: NoodAlertButton) => {
    setVisible(false);
    button.onPress?.();
  }, []);

  const value = useMemo(() => ({ showAlert }), [showAlert]);

  return (
    <NoodAlertContext.Provider value={value}>
      {children}
      <NoodAlertDialog
        visible={visible}
        config={config}
        onClose={closeAlert}
        onPressButton={handlePressButton}
      />
    </NoodAlertContext.Provider>
  );
}

export function useNoodAlert() {
  const context = useContext(NoodAlertContext);
  if (!context) {
    throw new Error('useNoodAlert must be used within NoodAlertProvider');
  }
  return context;
}

const styles = StyleSheet.create({
  modalHost: {
    flex: 1,
    zIndex: 10002,
    ...(Platform.OS === 'web' ? {} : { elevation: 10002 }),
  },
  alertCard: {
    ...noodDialogStyles.card,
  },
  title: {
    fontSize: 21,
    lineHeight: 28,
    fontWeight: '900',
    color: '#1a1a1a',
    letterSpacing: -0.2,
  },
  message: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 23,
    color: '#5f5f5f',
    fontWeight: '600',
  },
  actions: {
    marginTop: 22,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionsStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  actionsSplit: {
    justifyContent: 'space-between',
  },
  actionButton: {
    minHeight: 46,
    borderRadius: 15,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonStacked: {
    width: '100%',
  },
  actionButtonSplit: {
    flex: 1,
    minWidth: 0,
  },
  actionButtonPrimary: {
    backgroundColor: '#ff6a00',
    ...platformShadow('0 6px 14px rgba(255, 106, 0, 0.28)', {
      shadowColor: '#ff6a00',
      shadowOpacity: 0.28,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    }),
  },
  actionButtonSecondary: {
    backgroundColor: '#fffdf9',
    borderWidth: 1,
    borderColor: '#eadfd6',
  },
  actionButtonDanger: {
    backgroundColor: '#fff6f5',
    borderWidth: 1,
    borderColor: '#ffd0cc',
  },
  actionText: {
    fontSize: 15,
    fontWeight: '800',
  },
  actionTextPrimary: {
    color: '#fff',
  },
  actionTextSecondary: {
    color: '#6f5a4e',
  },
  actionTextDanger: {
    color: '#d64545',
  },
});