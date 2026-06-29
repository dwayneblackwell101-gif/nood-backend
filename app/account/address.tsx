import React, { useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUser } from '../../context/UserContext';
import { ShippingAddress, useAddressBook } from '../../context/AddressContext';
import { noodAlert } from '../../utils/nood-alert';

const EMPTY_FORM = {
  fullName: '',
  phone: '',
  address1: '',
  address2: '',
  city: '',
  region: '',
  country: '',
  postalCode: '',
  notes: '',
  isDefault: false,
};

type AddressFormState = typeof EMPTY_FORM;

function AddressContent() {
  const router = useRouter();
  const { settings } = useUser();
  const {
    addresses,
    loadingAddresses,
    isDeviceLocal,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
  } = useAddressBook();

  const [modalVisible, setModalVisible] = useState(false);
  const [editingAddress, setEditingAddress] = useState<ShippingAddress | null>(null);
  const [form, setForm] = useState<AddressFormState>({
    ...EMPTY_FORM,
    country: settings.country || '',
    region: settings.country || '',
  });

  const modalTitle = editingAddress ? 'Edit address' : 'Add new address';
  const hasAddresses = addresses.length > 0;

  const defaultAddressId = useMemo(
    () => addresses.find((address) => address.isDefault)?.id || addresses[0]?.id || '',
    [addresses]
  );

  const openAddModal = () => {
    setEditingAddress(null);
    setForm({
      ...EMPTY_FORM,
      country: settings.country || '',
      region: '',
      isDefault: addresses.length === 0,
    });
    setModalVisible(true);
  };

  const openEditModal = (address: ShippingAddress) => {
    setEditingAddress(address);
    setForm({
      fullName: address.fullName,
      phone: address.phone,
      address1: address.address1,
      address2: address.address2 || '',
      city: address.city,
      region: address.region,
      country: address.country || address.region || '',
      postalCode: address.postalCode || '',
      notes: address.notes || '',
      isDefault: address.isDefault,
    });
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setEditingAddress(null);
  };

  const updateField = (field: keyof AddressFormState, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const validateForm = () => {
    if (!form.fullName.trim()) return 'Enter the full name.';
    if (!form.phone.trim()) return 'Enter a phone number.';
    if (!form.address1.trim()) return 'Enter address line 1.';
    if (!form.city.trim()) return 'Enter the city or town.';
    if (!form.region.trim()) return 'Enter the region, state, or parish.';
    if (!form.country.trim()) return 'Enter the country.';
    return '';
  };

  const saveAddress = async () => {
    const error = validateForm();

    if (error) {
      noodAlert('Address needed', error);
      return;
    }

    const payload = {
      ...form,
      fullName: form.fullName.trim(),
      phone: form.phone.trim(),
      address1: form.address1.trim(),
      address2: form.address2.trim(),
      city: form.city.trim(),
      region: form.region.trim(),
      country: form.country.trim(),
      postalCode: form.postalCode.trim(),
      notes: form.notes.trim(),
    };

    if (editingAddress) {
      await updateAddress(editingAddress.id, payload);
    } else {
      await addAddress(payload);
    }

    closeModal();
  };

  const confirmDelete = (address: ShippingAddress) => {
    const runDelete = () => void deleteAddress(address.id);

    noodAlert('Delete address?', 'This removes the address from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: runDelete },
    ]);
  };

  const renderAddressLines = (address: ShippingAddress) => [
    address.address1,
    address.address2,
    address.city,
    address.region,
    address.country,
    address.postalCode,
  ].filter(Boolean);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#111" />
        </TouchableOpacity>

        <Text style={styles.title}>Address</Text>

        <TouchableOpacity style={styles.headerAddBtn} onPress={openAddModal} activeOpacity={0.88}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.cardTitleWrap}>
              <Text style={styles.heading}>Address book</Text>
              <Text style={styles.description}>
                Add a shipping address to make checkout faster.
              </Text>
            </View>
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{addresses.length}</Text>
            </View>
          </View>

          {isDeviceLocal ? (
            <View style={styles.deviceNotice}>
              <Ionicons name="phone-portrait-outline" size={18} color="#ff6a00" />
              <Text style={styles.deviceNoticeText}>
                Addresses are saved on this device. Sign in later to sync them to your account.
              </Text>
            </View>
          ) : null}

          {loadingAddresses ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Loading addresses...</Text>
            </View>
          ) : !hasAddresses ? (
            <View style={styles.emptyCard}>
              <Ionicons name="location-outline" size={42} color="#ff6a00" />
              <Text style={styles.emptyTitle}>No saved addresses yet</Text>
              <Text style={styles.emptyText}>Add a shipping address to make checkout faster.</Text>
              <TouchableOpacity style={styles.emptyButton} activeOpacity={0.9} onPress={openAddModal}>
                <Ionicons name="add-circle-outline" size={18} color="#fff" />
                <Text style={styles.emptyButtonText}>Add new address</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <TouchableOpacity style={styles.actionButton} activeOpacity={0.9} onPress={openAddModal}>
                <Ionicons name="add-circle-outline" size={20} color="#fff" />
                <Text style={styles.actionButtonText}>Add new address</Text>
              </TouchableOpacity>

              {addresses.map((address) => (
                <View key={address.id} style={styles.addressCard}>
                  <View style={styles.addressTopRow}>
                    <View style={styles.addressLabelWrap}>
                      <Ionicons
                        name={address.isDefault ? 'checkmark-circle' : 'location-outline'}
                        size={18}
                        color={address.isDefault ? '#5c31ff' : '#ff6a00'}
                      />
                      <Text style={styles.addressLabel}>
                        {address.isDefault ? 'Default shipping' : 'Shipping address'}
                      </Text>
                    </View>
                    {address.id === defaultAddressId ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>Default</Text>
                      </View>
                    ) : null}
                  </View>

                  <Text style={styles.addressName}>{address.fullName}</Text>
                  <Text style={styles.addressLine}>{address.phone}</Text>
                  {renderAddressLines(address).map((line) => (
                    <Text key={`${address.id}-${line}`} style={styles.addressLine}>
                      {line}
                    </Text>
                  ))}
                  {!!address.notes ? (
                    <Text style={styles.notesLine}>Notes: {address.notes}</Text>
                  ) : null}

                  <View style={styles.actionsRow}>
                    <TouchableOpacity style={styles.smallAction} onPress={() => openEditModal(address)}>
                      <Text style={styles.smallActionText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallAction} onPress={() => confirmDelete(address)}>
                      <Text style={styles.smallActionText}>Delete</Text>
                    </TouchableOpacity>
                    {!address.isDefault ? (
                      <TouchableOpacity
                        style={[styles.smallAction, styles.defaultAction]}
                        onPress={() => void setDefaultAddress(address.id)}
                      >
                        <Text style={styles.defaultActionText}>Set as default</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              ))}
            </>
          )}

          <TouchableOpacity
            style={styles.regionButton}
            activeOpacity={0.9}
            onPress={() => router.push('/account/settings' as any)}
          >
            <Ionicons name="globe-outline" size={17} color="#5c31ff" />
            <Text style={styles.regionButtonText}>Region and currency settings</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={modalVisible} transparent animationType="slide" onRequestClose={closeModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{modalTitle}</Text>
              <TouchableOpacity style={styles.closeBtn} onPress={closeModal}>
                <Ionicons name="close" size={20} color="#555" />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formContent}>
              <AddressInput label="Full name" value={form.fullName} onChangeText={(value) => updateField('fullName', value)} />
              <AddressInput label="Phone number" value={form.phone} onChangeText={(value) => updateField('phone', value)} keyboardType="phone-pad" />
              <AddressInput label="Address line 1" value={form.address1} onChangeText={(value) => updateField('address1', value)} />
              <AddressInput label="Address line 2 optional" value={form.address2} onChangeText={(value) => updateField('address2', value)} />
              <AddressInput label="City / town" value={form.city} onChangeText={(value) => updateField('city', value)} />
              <AddressInput label="Region / state / parish" value={form.region} onChangeText={(value) => updateField('region', value)} />
              <AddressInput label="Country" value={form.country} onChangeText={(value) => updateField('country', value)} />
              <AddressInput label="Postal code optional" value={form.postalCode} onChangeText={(value) => updateField('postalCode', value)} />
              <AddressInput
                label="Delivery instructions optional"
                value={form.notes}
                onChangeText={(value) => updateField('notes', value)}
                multiline
              />

              <View style={styles.defaultRow}>
                <View style={styles.defaultRowText}>
                  <Text style={styles.defaultRowTitle}>Set as default address</Text>
                  <Text style={styles.defaultRowCopy}>Use this address first at checkout.</Text>
                </View>
                <Switch
                  value={form.isDefault}
                  onValueChange={(value) => updateField('isDefault', value)}
                  trackColor={{ false: '#eadfd6', true: '#d8ccff' }}
                  thumbColor={form.isDefault ? '#5c31ff' : '#fff'}
                />
              </View>

              <TouchableOpacity style={styles.saveButton} activeOpacity={0.9} onPress={() => void saveAddress()}>
                <Text style={styles.saveButtonText}>{editingAddress ? 'Save address' : 'Add address'}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function AddressInput({
  label,
  value,
  onChangeText,
  keyboardType,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'phone-pad';
  multiline?: boolean;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType || 'default'}
        multiline={multiline}
        placeholderTextColor="#aaa"
      />
    </View>
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
  headerAddBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingBottom: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    shadowColor: '#ff6a00',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  cardTitleWrap: {
    flex: 1,
    paddingRight: 12,
  },
  heading: {
    fontSize: 20,
    fontWeight: '900',
    color: '#111',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  countBadge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#f1ecff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: '#5c31ff',
    fontSize: 14,
    fontWeight: '900',
  },
  deviceNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff7f2',
    borderRadius: 14,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  deviceNoticeText: {
    flex: 1,
    marginLeft: 8,
    color: '#6f5a4e',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
  },
  actionButton: {
    minHeight: 52,
    backgroundColor: '#ff6a00',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  emptyCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    alignItems: 'center',
  },
  emptyTitle: {
    marginTop: 10,
    fontSize: 18,
    fontWeight: '900',
    color: '#111',
  },
  emptyText: {
    marginTop: 7,
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyButton: {
    marginTop: 16,
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
  addressCard: {
    backgroundColor: '#fff7f2',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    marginBottom: 12,
  },
  addressTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  addressLabelWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingRight: 10,
  },
  addressLabel: {
    marginLeft: 6,
    fontSize: 13,
    fontWeight: '900',
    color: '#ff6a00',
  },
  badge: {
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#d9ccff',
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '900',
    color: '#5c31ff',
  },
  addressName: {
    fontSize: 17,
    fontWeight: '900',
    color: '#111',
    marginBottom: 6,
  },
  addressLine: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
  },
  notesLine: {
    marginTop: 8,
    color: '#6f5a4e',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  smallAction: {
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ffe4d6',
  },
  smallActionText: {
    color: '#6b5549',
    fontSize: 12,
    fontWeight: '900',
  },
  defaultAction: {
    backgroundColor: '#f1ecff',
    borderColor: '#d9ccff',
  },
  defaultActionText: {
    color: '#5c31ff',
    fontSize: 12,
    fontWeight: '900',
  },
  regionButton: {
    marginTop: 6,
    minHeight: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d9ccff',
    backgroundColor: '#f8f5ff',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  regionButtonText: {
    color: '#5c31ff',
    fontSize: 13,
    fontWeight: '900',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#111',
    fontSize: 22,
    fontWeight: '900',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff7f2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  formContent: {
    paddingBottom: 20,
  },
  inputGroup: {
    marginBottom: 12,
  },
  inputLabel: {
    marginBottom: 7,
    color: '#4a3b33',
    fontSize: 13,
    fontWeight: '900',
  },
  input: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#ffe4d6',
    backgroundColor: '#fff7f2',
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#111',
    fontSize: 15,
    fontWeight: '700',
  },
  inputMultiline: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  defaultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f8f5ff',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#d9ccff',
    marginBottom: 14,
  },
  defaultRowText: {
    flex: 1,
    paddingRight: 12,
  },
  defaultRowTitle: {
    color: '#111',
    fontSize: 15,
    fontWeight: '900',
  },
  defaultRowCopy: {
    color: '#6f5a4e',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  saveButton: {
    minHeight: 54,
    borderRadius: 16,
    backgroundColor: '#ff6a00',
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
  },
});

export default function AddressScreen() {
  return <AddressContent />;
}