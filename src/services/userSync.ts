import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { AppSettings } from '../types/market';

export interface UserCloudData {
  uid: string;
  email?: string;
  displayName?: string;
  favorites?: string[];
  settings?: Partial<AppSettings>;
  updatedAt?: string;
}

export async function fetchUserData(userId: string): Promise<UserCloudData | null> {
  const docPath = `users/${userId}`;
  try {
    const snap = await getDoc(doc(db, 'users', userId));
    if (snap.exists()) {
      return snap.data() as UserCloudData;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, docPath);
  }
}

export async function saveUserData(
  userId: string,
  data: Partial<UserCloudData>
): Promise<void> {
  const docPath = `users/${userId}`;
  try {
    await setDoc(
      doc(db, 'users', userId),
      {
        uid: userId,
        ...data,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, docPath);
  }
}
