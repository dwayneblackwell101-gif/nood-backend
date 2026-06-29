import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const PROFILE_PICTURE_DIR = `${FileSystem.documentDirectory || ''}profile-pictures/`;

const storageKey = (profileId: string) => `profilePhoto:${profileId}`;
const legacyStorageKey = (profileId: string) => `NOOD_PROFILE_PICTURE_URI:${profileId}`;

export async function getProfilePictureUri(profileId: string): Promise<string | null> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    return null;
  }

  try {
    let savedUri = await AsyncStorage.getItem(storageKey(normalizedProfileId));

    if (!savedUri) {
      savedUri = await AsyncStorage.getItem(legacyStorageKey(normalizedProfileId));
      if (savedUri) {
        await AsyncStorage.setItem(storageKey(normalizedProfileId), savedUri);
      }
    }

    if (!savedUri) {
      return null;
    }

    const info = await FileSystem.getInfoAsync(savedUri);
    return info.exists ? savedUri : null;
  } catch (error) {
    console.log('Failed to load profile picture:', error);
    return null;
  }
}

export async function saveProfilePicture(profileId: string, sourceUri: string): Promise<string> {
  const normalizedProfileId = String(profileId || '').trim();
  if (!normalizedProfileId) {
    throw new Error('Missing profile id');
  }

  await FileSystem.makeDirectoryAsync(PROFILE_PICTURE_DIR, { intermediates: true });

  const destinationUri = `${PROFILE_PICTURE_DIR}${normalizedProfileId}.jpg`;
  const existingUri =
    (await AsyncStorage.getItem(storageKey(normalizedProfileId))) ||
    (await AsyncStorage.getItem(legacyStorageKey(normalizedProfileId)));

  if (existingUri && existingUri !== destinationUri) {
    const existingInfo = await FileSystem.getInfoAsync(existingUri);
    if (existingInfo.exists) {
      await FileSystem.deleteAsync(existingUri, { idempotent: true });
    }
  }

  await FileSystem.copyAsync({ from: sourceUri, to: destinationUri });
  await AsyncStorage.setItem(storageKey(normalizedProfileId), destinationUri);
  await AsyncStorage.removeItem(legacyStorageKey(normalizedProfileId));

  return destinationUri;
}