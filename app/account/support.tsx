import React, { useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { WebView } from 'react-native-webview';
import { SHOPIFY_STORE_DOMAIN } from '../../utils/shopify';
import NoodSpinner from '../../components/NoodSpinner';

const PUBLIC_STORE_URL = 'https://noodcaribbean.com';
const SHOPIFY_SUPPORT_URL = `${PUBLIC_STORE_URL}/pages/contact`;
const SHOPIFY_STORE_URL = `https://${SHOPIFY_STORE_DOMAIN}`;

const SUPPORT_URLS = [SHOPIFY_SUPPORT_URL, SHOPIFY_STORE_URL];

const OPEN_CHAT_SCRIPT = `
  (function () {
    function openMooseDesk() {
      var selectors = [
        '[aria-label*="chat" i]',
        '[aria-label*="support" i]',
        '[class*="moosedesk" i]',
        '[id*="moosedesk" i]',
        'button'
      ];

      for (var i = 0; i < selectors.length; i += 1) {
        var nodes = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < nodes.length; j += 1) {
          var node = nodes[j];
          var text = (node.innerText || node.getAttribute('aria-label') || '').toLowerCase();
          if (text.indexOf('chat') >= 0 || text.indexOf('support') >= 0 || selectors[i].indexOf('moosedesk') >= 0) {
            try {
              node.click();
              return true;
            } catch (error) {}
          }
        }
      }

      return false;
    }

    setTimeout(openMooseDesk, 1200);
    setTimeout(openMooseDesk, 2600);
    true;
  })();
`;

export default function SupportScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [sourceIndex, setSourceIndex] = useState(0);
  const supportUrl = SUPPORT_URLS[sourceIndex] || SHOPIFY_STORE_URL;

  const handleBackPress = () => {
    router.back();
  };

  const openExternal = () => {
    void Linking.openURL(supportUrl);
  };

  const handleLoadError = () => {
    if (sourceIndex < SUPPORT_URLS.length - 1) {
      setLoading(true);
      setSourceIndex((current) => current + 1);
      return;
    }

    setLoading(false);
  };

  const webSource = useMemo(() => ({ uri: supportUrl }), [supportUrl]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={handleBackPress}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Support</Text>

        <TouchableOpacity style={styles.backBtn} onPress={openExternal}>
          <Ionicons name="open-outline" size={21} color="#111" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingOverlay}>
          <NoodSpinner size={28} />
          <Text style={styles.loadingText}>Opening support...</Text>
        </View>
      ) : null}

      {Platform.OS === 'web' ? (
        <iframe
          src={supportUrl}
          title="MooseDesk Support"
          style={styles.iframe as any}
          onLoad={() => setLoading(false)}
        />
      ) : (
        <WebView
          key={supportUrl}
          source={webSource}
          onLoadEnd={() => setLoading(false)}
          onError={handleLoadError}
          onHttpError={handleLoadError}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          injectedJavaScript={OPEN_CHAT_SCRIPT}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loader}>
              <NoodSpinner size={28} />
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#fff7f2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#f1ddd0',
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
  loadingOverlay: {
    position: 'absolute',
    top: 76,
    left: 0,
    right: 0,
    zIndex: 5,
    alignItems: 'center',
    pointerEvents: 'none',
  },
  loadingText: {
    marginTop: 8,
    color: '#666',
    fontSize: 13,
    fontWeight: '600',
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iframe: {
    flex: 1,
    width: '100%',
    borderWidth: 0,
    backgroundColor: '#fff',
  },
});
