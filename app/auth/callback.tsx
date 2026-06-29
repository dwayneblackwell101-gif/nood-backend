import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUser } from '../../context/UserContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import { logAuthRestartCheck } from '../../utils/auth-restart-debug';
import { isAppBootstrapComplete } from '../../utils/app-bootstrap';
import { navigateAfterAuthSignIn } from '../../utils/auth-navigation';
import { processShopifyAuthCallbackFromParams } from '../../utils/shopify-auth-session';

export default function ShopifyAuthCallbackScreen() {
  const router = useRouter();
  const { markSignedIn, isAuthLoading } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const { code, state, error, error_description } = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [message, setMessage] = useState('Finishing your NOOD sign-in...');

  useEffect(() => {
    logAuthRestartCheck({
      step: 'auth-callback-screen-mounted',
      isAppBootstrapping: !isAppBootstrapComplete(),
      isAuthLoading,
    });

    const finishAuth = async () => {
      if (Platform.OS === 'web') {
        setStatus('error');
        setMessage('Return to NOOD to finish signing in.');
        return;
      }

      try {
        const processed = await processShopifyAuthCallbackFromParams(
          {
            code: code ? String(code) : undefined,
            state: state ? String(state) : undefined,
            error: error ? String(error) : undefined,
            error_description: error_description ? String(error_description) : undefined,
          },
          {
            markSignedIn,
            addHistoryEvent,
            redirectToAccount: () => {
              navigateAfterAuthSignIn();
            },
          }
        );

        if (!processed.handled) {
          setStatus('error');
          setMessage(processed.errorMessage || 'NOOD could not finish sign-in. Please try again.');
          return;
        }

        if (!processed.signedIn) {
          setStatus('error');
          setMessage(
            processed.errorMessage ||
              error_description ||
              'Shopify sign-in did not complete.'
          );
        }
      } catch (callbackError) {
        console.log('[AUTH] callback screen error', callbackError);
        setStatus('error');
        setMessage(
          callbackError instanceof Error
            ? callbackError.message
            : 'NOOD could not finish sign-in. Please try again.'
        );
      }
    };

    void finishAuth();
  }, [addHistoryEvent, code, error, error_description, isAuthLoading, markSignedIn, router, state]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.wrap}>
        {status === 'loading' ? (
          <>
            <ActivityIndicator size="small" color="#ff6a00" />
            <Text style={styles.title}>Signing you in</Text>
            <Text style={styles.copy}>{message}</Text>
          </>
        ) : (
          <>
            <View style={styles.errorIcon}>
              <Ionicons name="alert-circle-outline" size={28} color="#b64900" />
            </View>
            <Text style={styles.title}>Sign-in needs another try</Text>
            <Text style={styles.copy}>{message}</Text>
            <TouchableOpacity
              style={styles.button}
              activeOpacity={0.9}
              onPress={() => router.replace('/sign-in')}
            >
              <Text style={styles.buttonText}>Back to sign in</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#fff',
  },
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  title: {
    marginTop: 18,
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  copy: {
    marginTop: 10,
    fontSize: 15,
    lineHeight: 22,
    color: '#666',
    textAlign: 'center',
    maxWidth: 320,
  },
  errorIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff2e8',
  },
  button: {
    marginTop: 20,
    minHeight: 50,
    minWidth: 180,
    borderRadius: 16,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
});