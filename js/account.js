import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, addDoc, collection, query, orderBy, limit, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp({ /* paste firebaseConfig here */ });
const auth = getAuth(app);
const db = getFirestore(app);

export const signIn = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);
export const onUser = (fn) => onAuthStateChanged(auth, fn);

export async function saveRun(run) {
  const u = auth.currentUser;
  if (!u) return;                       // guests keep working exactly as now
  await addDoc(collection(db, 'users', u.uid, 'runs'), { ...run, createdAt: serverTimestamp() });
}

export async function recentRuns(n = 20) {
  const u = auth.currentUser;
  const q = query(collection(db, 'users', u.uid, 'runs'), orderBy('createdAt', 'desc'), limit(n));
  return (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export const saveProfile = (prefs) => setDoc(doc(db, 'users', auth.currentUser.uid), prefs, { merge: true });
