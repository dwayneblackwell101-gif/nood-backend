import React, { useEffect, useState } from 'react';
import {
  Linking,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUser } from '../../context/UserContext';
import { useHistoryEvents } from '../../context/HistoryContext';
import NoodSpinner from '../../components/NoodSpinner';
import {
  getEmailFromClaims,
  getDisplayNameFromClaims,
  parseJwtPayload,
  SHOPIFY_AUTH_STORAGE_KEY,
  SHOPIFY_APP_REDIRECT_URI,
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
  SHOPIFY_REDIRECT_URI,
  SHOPIFY_TOKEN_ENDPOINT,
} from '../../utils/shopify-auth';

const SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY = 'NOOD_SHOPIFY_CUSTOMER_PROFILE';

export default function ShopifyAuthCallbackScreen() {
  const router = useRouter();
  const { markSignedIn } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const { code, state, error, error_description } = useLocalSearchParams<{
    code?: string;
    state?: string;
    error?: string;
    error_description?: string;
  }>();
  const [status, setStatus] = useState<'loading' | 'error'>('loading');
  const [message, setMessage] = useState('Finishing your NOOD sign-in...');

  const appCallbackUrl = React.useMemo(() => {
    const params = new URLSearchParams();

    if (code) params.set('code', String(code));
    if (state) params.set('state', String(state));
    if (error) params.set('error', String(error));
    if (error_description) params.set('error_description', String(error_description));

    return `${SHOPIFY_APP_REDIRECT_URI}?${params.toString()}`;
  }, [code, error, error_description, state]);

  useEffect(() => {
    const finishAuth = async () => {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') {
          window.location.href = appCallbackUrl;
        }
        setStatus('error');
        setMessage('Return to NOOD to finish signing in.');
        return;
      }

      try {
        const initialCallbackUrl = await Linking.getInitialURL().catch(() => null);
        console.log('SHOPIFY_CALLBACK_RECEIVED', initialCallbackUrl || 'router-params');
        console.log('SHOPIFY_CALLBACK_URL_RECEIVED', initialCallbackUrl || 'router-params');
        console.log('SHOPIFY_CALLBACK_PARAMS_RECEIVED', {
          code: code ? '[present]' : '',
          state: state ? '[present]' : '',
          error: error || '',
          error_description: error_description || '',
        });

        const savedPayload = await AsyncStorage.getItem(SHOPIFY_AUTH_STORAGE_KEY);
        const pending = savedPayload ? JSON.parse(savedPayload) : null;
        console.log('SHOPIFY_STORED_REDIRECT_URI', pending?.redirectUri || '');

        if (error) {
          console.log('SHOPIFY_LOGIN_ERROR', {
            error,
            error_description: error_description || '',
          });
          setStatus('error');
          setMessage(error_description || 'Shopify sign-in did not complete.');
          await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
          return;
        }

        if (!code) {
          await markSignedIn();
          await AsyncStorage.setItem(
            SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY,
            JSON.stringify({
              displayName: '',
              email: '',
              source: 'shopify-hosted-account-callback',
              signedInAt: new Date().toISOString(),
            })
          );
          void addHistoryEvent({
            type: 'account',
            title: 'Signed in',
            description: 'Customer signed in to NOOD with Shopify.',
            status: 'signed-in',
          });
          await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
          console.log('SHOPIFY_LOGIN_SUCCESS', {
            source: 'hosted-account-callback',
            code: '',
          });
          router.replace('/account');
          return;
        }

        if (!state || !pending?.state || state !== pending.state) {
          console.log('SHOPIFY_LOGIN_ERROR', {
            reason: 'invalid_state',
            hasCode: !!code,
            hasState: !!state,
            hasPendingState: !!pending?.state,
            stateMatches: !!state && !!pending?.state && state === pending.state,
          });
          setStatus('error');
          setMessage('NOOD could not verify the sign-in callback. Please try again.');
          await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
          return;
        }

        const tokenPayload = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID_PUBLIC,
          redirect_uri: pending.redirectUri || SHOPIFY_REDIRECT_URI,
          code,
        });
        console.log('SHOPIFY_TOKEN_EXCHANGE_REDIRECT_URI', pending.redirectUri || SHOPIFY_REDIRECT_URI);

        if (pending.codeVerifier) {
          tokenPayload.set('code_verifier', pending.codeVerifier);
        }

        const tokenResponse = await fetch(SHOPIFY_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: tokenPayload.toString(),
        });

        if (!tokenResponse.ok) {
          const tokenErrorBody = await tokenResponse.text().catch(() => '');
          console.log('SHOPIFY_TOKEN_EXCHANGE_FAILED', {
            status: tokenResponse.status,
            body: tokenErrorBody,
          });
          throw new Error(`Shopify token exchange failed: ${tokenResponse.status} ${tokenErrorBody}`);
        }

        const tokenJson = (await tokenResponse.json()) as {
          id_token?: string;
        };
        const claims = parseJwtPayload(tokenJson.id_token);
        const displayName = getDisplayNameFromClaims(claims);
        const email = getEmailFromClaims(claims);
        console.log('SHOPIFY_TOKEN_EXCHANGE_SUCCESS', {
          hasIdToken: !!tokenJson.id_token,
          email: email || '',
          displayName: displayName || '',
        });
        console.log('SHOPIFY_LOGIN_SUCCESS', {
          email: email || '',
          displayName: displayName || '',
        });

        await markSignedIn(displayName);
        await AsyncStorage.setItem(
          SHOPIFY_CUSTOMER_PROFILE_STORAGE_KEY,
          JSON.stringify({
            displayName,
            email,
            signedInAt: new Date().toISOString(),
          })
        );
        void addHistoryEvent({
          type: 'account',
          title: 'Signed in',
          description: displayName ? `${displayName} signed in to NOOD.` : 'Customer signed in to NOOD.',
          status: 'signed-in',
        });
        await AsyncStorage.removeItem(SHOPIFY_AUTH_STORAGE_KEY);
        router.replace('/account');
      } catch (callbackError) {
        console.log('Shopify auth callback error:', callbackError);
        console.log('SHOPIFY_LOGIN_ERROR', callbackError);
        setStatus('error');
        setMessage(callbackError instanceof Error ? callbackError.message : 'NOOD could not finish sign-in. Please try again.');
      }
    };

    void finishAuth();
  }, [addHistoryEvent, appCallbackUrl, code, error, error_description, markSignedIn, router, state]);

  const openAppCallback = async () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.href = appCallbackUrl;
      return;
    }

    await Linking.openURL(appCallbackUrl);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.wrap}>
        {status === 'loading' ? (
          <>
            <NoodSpinner size={52} />
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
              onPress={Platform.OS === 'web' ? openAppCallback : () => router.replace('/sign-in')}
            >
              <Text style={styles.buttonText}>{Platform.OS === 'web' ? 'Return to NOOD' : 'Back to sign in'}</Text>
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
