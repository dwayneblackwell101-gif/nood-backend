import React from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

type AccountGuestStateProps = {
  title: string;
  subtitle: string;
  icon?: IconName;
  buttonText?: string;
  headerTitle?: string;
  showHeader?: boolean;
};

export default function AccountGuestState({
  title,
  subtitle,
  icon = 'person-circle-outline',
  buttonText = 'Go to sign in',
  headerTitle,
  showHeader = false,
}: AccountGuestStateProps) {
  const router = useRouter();

  const goToSignIn = () => {
    router.push('/sign-in' as any);
  };

  return (
    <SafeAreaView style={styles.container}>
      {showHeader ? (
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.88}>
            <Ionicons name="arrow-back" size={22} color="#111" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{headerTitle || 'Account'}</Text>
          <View style={styles.headerSpacer} />
        </View>
      ) : null}

      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons name={icon} size={36} color="#ff6a00" />
        </View>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        <TouchableOpacity style={styles.button} activeOpacity={0.9} onPress={goToSignIn}>
          <Ionicons name="person-circle-outline" size={18} color="#fff" />
          <Text style={styles.buttonText}>{buttonText}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff7f2',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
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
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111',
  },
  headerSpacer: {
    width: 42,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 40,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    color: '#111',
    textAlign: 'center',
  },
  subtitle: {
    marginTop: 10,
    fontSize: 14,
    lineHeight: 21,
    color: '#666',
    textAlign: 'center',
    maxWidth: 320,
    fontWeight: '600',
  },
  button: {
    marginTop: 22,
    minHeight: 50,
    paddingHorizontal: 22,
    borderRadius: 999,
    backgroundColor: '#ff6a00',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
});