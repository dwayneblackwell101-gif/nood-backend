import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as WebBrowser from 'expo-web-browser';
import { useHistoryEvents } from '../context/HistoryContext';
import { useUser } from '../context/UserContext';
import { logAuthRestartCheck } from '../utils/auth-restart-debug';
import { isAppBootstrapComplete } from '../utils/app-bootstrap';
import { handleShopifyAuthRedirectUrl } from '../utils/shopify-auth-handlers';
import { launchShopifyAuthSession } from '../utils/shopify-auth-launcher';
import { noodAlert } from '../utils/nood-alert';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_LOGO_URL =
  'https://cdn.shopify.com/s/files/1/0663/2099/0292/files/2a5758d6-4edb-4047-87bb-e6b94dbbbab0-cover.png?v=1781936734';

export default function SignInScreen() {
  const router = useRouter();
  const { markSignedIn } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const [openingProvider, setOpeningProvider] = useState<string | null>(null);

  const openAuth = useCallback(
    async (provider: 'google' | 'facebook' | 'shop' | 'email' | 'phone') => {
      if (openingProvider) return;

      setOpeningProvider(provider);
      logAuthRestartCheck({
        step: 'sign-in-open-auth',
        isAppBootstrapping: !isAppBootstrapComplete(),
        isAuthLoading: true,
        detail: { provider },
      });

      await launchShopifyAuthSession({
        provider,
        onRedirectUrl: async (url) => {
          await handleShopifyAuthRedirectUrl(url, {
            markSignedIn,
            addHistoryEvent,
          });
        },
        onError: (message) => {
          noodAlert('Sign-in unavailable', message);
        },
      });

      setOpeningProvider(null);
    },
    [addHistoryEvent, markSignedIn, openingProvider]
  );

  const handleBackPress = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/(tabs)/account');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={handleBackPress}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Sign In</Text>

        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.heroCard}>
        <Text style={styles.heroTitle}>Access your NOOD account</Text>
        <Text style={styles.heroText}>
          Sign in with Shopify customer accounts to see your orders, saved details,
          and account updates in one place.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.primaryButton}
        activeOpacity={0.9}
        disabled={Boolean(openingProvider)}
        onPress={() => {
          void openAuth('google');
        }}
      >
        <Image source={{ uri: GOOGLE_LOGO_URL }} style={styles.googleLogo} resizeMode="contain" />
        <Text style={styles.primaryButtonText}>Continue with Google</Text>
        {openingProvider === 'google' ? (
          <ActivityIndicator size="small" color="#ff6a00" style={styles.buttonSpinner} />
        ) : null}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.facebookButton}
        activeOpacity={0.9}
        onPress={() => {
          void openAuth('facebook');
        }}
      >
        <View style={styles.facebookIconWrap}>
          <Text style={styles.facebookIconText}>f</Text>
        </View>
        <Text style={styles.facebookButtonText}>Continue with Facebook</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.shopButton}
        activeOpacity={0.9}
        onPress={() => {
          void openAuth('shop');
        }}
      >
        <View style={styles.shopIconWrap}>
          <Ionicons name="bag-handle" size={18} color="#5433EB" />
        </View>
        <Text style={styles.shopButtonText}>Continue with Shop</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondaryButton}
        activeOpacity={0.9}
        onPress={() => {
          void openAuth('email');
        }}
      >
        <Ionicons name="mail-outline" size={20} color="#ff6a00" />
        <Text style={styles.secondaryButtonText}>Continue with Email</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.secondaryButton}
        activeOpacity={0.9}
        onPress={() => {
          void openAuth('phone');
        }}
      >
        <Ionicons name="phone-portrait-outline" size={20} color="#ff6a00" />
        <Text style={styles.secondaryButtonText}>Continue with phone number</Text>
      </TouchableOpacity>

      <View style={styles.noteCard}>
        <Ionicons name="shield-checkmark-outline" size={18} color="#ff6a00" />
        <Text style={styles.noteText}>
          Sign-in is handled by Shopify customer accounts for a secure checkout and
          account experience.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
    marginTop: 8,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  headerSpacer: {
    width: 42,
  },
  heroCard: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 20,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 18,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  heroText: {
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
  },
  primaryButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e8ddd4',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  primaryButtonText: {
    marginLeft: 10,
    color: '#111',
    fontSize: 16,
    fontWeight: '800',
  },
  googleLogo: {
    width: 22,
    height: 22,
  },
  facebookButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e8ddd4',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  facebookIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1877F2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  facebookIconText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif',
  },
  facebookButtonText: {
    marginLeft: 10,
    color: '#111',
    fontSize: 16,
    fontWeight: '800',
  },
  shopButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e8ddd4',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  shopIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#F3EEFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shopButtonText: {
    marginLeft: 10,
    color: '#111',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#fff0e7',
    borderWidth: 1,
    borderColor: '#ffd9c6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  secondaryButtonText: {
    marginLeft: 10,
    color: '#ff6a00',
    fontSize: 16,
    fontWeight: '800',
  },
  noteCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  noteText: {
    flex: 1,
    marginLeft: 10,
    color: '#666',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
  },
  buttonSpinner: {
    marginLeft: 10,
  },
});
