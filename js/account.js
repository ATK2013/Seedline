// Farmer accounts: Google sign-in (Firebase Auth), with the fields a farmer
// checks and their settings kept in Cloud Firestore under users/{uid}.
// Accounts are optional: app.js loads this module on the side, so the app
// keeps working for guests, offline, or if Firebase cannot be reached.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, addDoc, collection, query, orderBy, limit, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// A Firebase web config is not a secret: the Firestore security rules are
// what keep each farmer's data private.
const firebaseConfig = {
  apiKey: 'AIzaSyBmKAy40xzNcOjm9lJpTiPPTPAzOaBiJT8',
  authDomain: 'see0dline-atk2013.firebaseapp.com',
  projectId: 'see0dline-atk2013',
  storageBucket: 'see0dline-atk2013.firebasestorage.app',
  messagingSenderId: '434324062110',
  appId: '1:434324062110:web:9755b1714e6f7ff02b208f',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const uid = () => auth.currentUser?.uid ?? null;

export const signIn = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);
export const onUser = (fn) => onAuthStateChanged(auth, fn);

/** Save one checked field. Does nothing for guests. */
export async function saveRun(run) {
  const id = uid();
  if (!id) return null;
  return addDoc(collection(db, 'users', id, 'runs'), { ...run, createdAt: serverTimestamp() });
}

/** The most recent fields this farmer checked, newest first. Empty for guests. */
export async function recentRuns(n = 20) {
  const id = uid();
  if (!id) return [];
  const q = query(collection(db, 'users', id, 'runs'), orderBy('createdAt', 'desc'), limit(n));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Settings that follow the farmer between devices (language, units). */
export async function saveProfile(prefs) {
  const id = uid();
  if (!id) return;
  await setDoc(doc(db, 'users', id), prefs, { merge: true });
}

export async function loadProfile() {
  const id = uid();
  if (!id) return {};
  const snap = await getDoc(doc(db, 'users', id));
  return snap.exists() ? snap.data() : {};
}
