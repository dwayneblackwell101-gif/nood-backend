import React, { useMemo, useState } from 'react';
import {
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Switch,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useHistoryEvents } from '../../context/HistoryContext';
import { useUser } from '../../context/UserContext';
import { useUpdates } from '../../context/UpdatesContext';
import NoodDialogShell from '../../components/NoodDialogShell';
import NoodSpinner from '../../components/NoodSpinner';

type PickerModalProps = {
  visible: boolean;
  title: string;
  options: { label: string; value: string }[];
  selectedValue: string;
  onClose: () => void;
  onSelect: (value: string) => void;
};

function PickerModal({
  visible,
  title,
  options,
  selectedValue,
  onClose,
  onSelect,
}: PickerModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <NoodDialogShell placement="bottom" onBackdropPress={onClose} cardStyle={styles.modalCard}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{title}</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#6f5a4e" />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {options.map((item) => {
            const active = item.value === selectedValue;

            return (
              <TouchableOpacity
                key={item.value}
                style={[styles.optionRow, active && styles.optionRowActive]}
                onPress={() => {
                  onSelect(item.value);
                  onClose();
                }}
              >
                <Text style={[styles.optionText, active && styles.optionTextActive]}>
                  {item.label}
                </Text>

                {active ? (
                  <Ionicons name="checkmark" size={20} color="#ff6a00" />
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </NoodDialogShell>
    </Modal>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const {
    settings,
    isReady,
    isSignedIn,
    updateCountry,
    updateCurrency,
    updateLanguage,
    resetCurrencyToCountryDefault,
    signOut,
    availableCountries,
    availableCurrencies,
    availableLanguages,
  } = useUser();
  const { addHistoryEvent } = useHistoryEvents();
  const {
    notificationSettings,
    expoPushToken,
    updateNotificationSetting,
  } = useUpdates();

  const [countryOpen, setCountryOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);

  const selectedCountryName = useMemo(() => {
    return (
      availableCountries.find((country) => country.code === settings.country)?.name ||
      settings.country
    );
  }, [availableCountries, settings.country]);

  const handleBackPress = () => {
    router.back();
  };

  const handleSignOut = async () => {
    await addHistoryEvent({
      type: 'account',
      title: 'Signed out',
      description: 'Customer signed out of NOOD on this device.',
      status: 'signed-out',
    });
    await signOut();
    router.replace('/(tabs)/account');
  };

  const countryOptions = availableCountries.map((country) => ({
    label: `${country.name} (${country.code})`,
    value: country.code,
  }));

  const currencyOptions = availableCurrencies.map((currency) => ({
    label: currency,
    value: currency,
  }));

  const languageOptions = availableLanguages.map((language) => ({
    label: language,
    value: language,
  }));

  if (!isReady) {
    return (
      <SafeAreaView style={styles.loadingWrap}>
        <NoodSpinner size={52} />
        <Text style={styles.loadingText}>Loading settings...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={handleBackPress}>
            <Ionicons name="arrow-back" size={22} color="#111" />
          </TouchableOpacity>

          <Text style={styles.pageTitle}>Settings</Text>

          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Country</Text>

          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setCountryOpen(true)}
          >
            <View>
              <Text style={styles.dropdownLabel}>Selected country</Text>
              <Text style={styles.dropdownValue}>{selectedCountryName}</Text>
            </View>

            <Ionicons name="chevron-down" size={22} color="#111" />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Currency</Text>

          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setCurrencyOpen(true)}
          >
            <View>
              <Text style={styles.dropdownLabel}>Current currency</Text>
              <Text style={styles.dropdownValue}>{settings.currency}</Text>
            </View>

            <Ionicons name="chevron-down" size={22} color="#111" />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Language</Text>

          <TouchableOpacity
            style={styles.dropdown}
            onPress={() => setLanguageOpen(true)}
          >
            <View>
              <Text style={styles.dropdownLabel}>Current language</Text>
              <Text style={styles.dropdownValue}>{settings.language}</Text>
            </View>

            <Ionicons name="chevron-down" size={22} color="#111" />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.resetBtn} onPress={() => void resetCurrencyToCountryDefault()}>
          <Text style={styles.resetText}>Reset to country default</Text>
        </TouchableOpacity>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notifications</Text>

          <NotificationToggle
            title="Notifications"
            subtitle={expoPushToken ? 'Phone notifications are ready.' : 'Turn on to allow NOOD alerts.'}
            value={notificationSettings.notificationsEnabled}
            onValueChange={(value) => void updateNotificationSetting('notificationsEnabled', value)}
          />
          <NotificationToggle
            title="Deals alerts"
            subtitle="Sales, coupons, and price drops."
            value={notificationSettings.dealsAlerts}
            disabled={!notificationSettings.notificationsEnabled}
            onValueChange={(value) => void updateNotificationSetting('dealsAlerts', value)}
          />
          <NotificationToggle
            title="Rewards alerts"
            subtitle="Lucky Spin, locked rewards, and unlock reminders."
            value={notificationSettings.rewardsAlerts}
            disabled={!notificationSettings.notificationsEnabled}
            onValueChange={(value) => void updateNotificationSetting('rewardsAlerts', value)}
          />
          <NotificationToggle
            title="Order/shipping alerts"
            subtitle="Order status and package tracking updates."
            value={notificationSettings.shippingAlerts}
            disabled={!notificationSettings.notificationsEnabled}
            onValueChange={(value) => void updateNotificationSetting('shippingAlerts', value)}
          />

          <TouchableOpacity
            style={styles.updatesLinkBtn}
            activeOpacity={0.9}
            onPress={() => router.push('/account/updates' as any)}
          >
            <Ionicons name="notifications-outline" size={18} color="#ff6a00" />
            <Text style={styles.updatesLinkText}>Open NOOD updates inbox</Text>
            <Ionicons name="chevron-forward" size={18} color="#999" />
          </TouchableOpacity>
        </View>

        {isSignedIn ? (
          <TouchableOpacity style={styles.signOutBtn} onPress={() => void handleSignOut()}>
            <Ionicons name="log-out-outline" size={18} color="#fff" />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        ) : null}

        <PickerModal
          visible={countryOpen}
          title="Select country"
          options={countryOptions}
          selectedValue={settings.country}
          onClose={() => setCountryOpen(false)}
          onSelect={(value) => {
            void updateCountry(value);
          }}
        />

        <PickerModal
          visible={currencyOpen}
          title="Select currency"
          options={currencyOptions}
          selectedValue={settings.currency}
          onClose={() => setCurrencyOpen(false)}
          onSelect={(value) => {
            void updateCurrency(value);
          }}
        />

        <PickerModal
          visible={languageOpen}
          title="Select language"
          options={languageOptions}
          selectedValue={settings.language}
          onClose={() => setLanguageOpen(false)}
          onSelect={(value) => {
            void updateLanguage(value);
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function NotificationToggle({
  title,
  subtitle,
  value,
  disabled = false,
  onValueChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={[styles.toggleRow, disabled && styles.toggleRowDisabled]}>
      <View style={styles.toggleTextWrap}>
        <Text style={styles.toggleTitle}>{title}</Text>
        <Text style={styles.toggleSubtitle}>{subtitle}</Text>
      </View>
      <Switch
        value={value && !disabled}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: '#eadfd6', true: '#d8ccff' }}
        thumbColor={value && !disabled ? '#5c31ff' : '#fff'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f7f4f2',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  loadingWrap: {
    flex: 1,
    backgroundColor: '#f7f4f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: '#666',
    fontWeight: '600',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#f2c7ab',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerSpacer: {
    width: 42,
  },
  pageTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
    textAlign: 'center',
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111',
    marginBottom: 10,
  },
  dropdown: {
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#f2c7ab',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownLabel: {
    fontSize: 13,
    color: '#777',
    marginBottom: 4,
  },
  dropdownValue: {
    fontSize: 22,
    fontWeight: '800',
    color: '#111',
  },
  resetBtn: {
    marginTop: 8,
    borderWidth: 1.5,
    borderColor: '#f2c7ab',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  resetText: {
    color: '#ff6a00',
    fontWeight: '800',
    fontSize: 16,
  },
  toggleRow: {
    backgroundColor: '#fff7f2',
    borderWidth: 1,
    borderColor: '#f2c7ab',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleRowDisabled: {
    opacity: 0.55,
  },
  toggleTextWrap: {
    flex: 1,
    paddingRight: 12,
  },
  toggleTitle: {
    color: '#111',
    fontSize: 15,
    fontWeight: '900',
  },
  toggleSubtitle: {
    color: '#777',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
    marginTop: 3,
  },
  signOutBtn: {
    marginTop: 12,
    backgroundColor: '#111',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  signOutText: {
    marginLeft: 8,
    color: '#fff',
    fontWeight: '800',
    fontSize: 16,
  },
  updatesLinkBtn: {
    marginTop: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#f2c7ab',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  updatesLinkText: {
    flex: 1,
    marginLeft: 10,
    color: '#111',
    fontSize: 15,
    fontWeight: '800',
  },
  modalCard: {
    paddingBottom: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111',
  },
  optionRow: {
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f1f1',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionRowActive: {
    backgroundColor: '#fff7f2',
    borderRadius: 12,
  },
  optionText: {
    fontSize: 15,
    color: '#111',
  },
  optionTextActive: {
    fontWeight: '800',
    color: '#ff6a00',
  },
});
