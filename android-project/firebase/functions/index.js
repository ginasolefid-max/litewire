const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// Sends an ultra-lightweight data-only FCM push (~120 bytes) with NO plaintext content.
exports.notifyNewMessage = onDocumentCreated(
  "conversations/{conversationId}/messages/{messageId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const msg = snap.data();
    const db = getFirestore();

    const convoSnap = await db.doc(`conversations/${event.params.conversationId}`).get();
    if (!convoSnap.exists) return;

    const participants = convoSnap.data().participants || [];
    const recipientId = participants.find((uid) => uid !== msg.senderId);
    if (!recipientId) return;

    const tokenSnap = await db.doc(`userTokens/${recipientId}`).get();
    if (!tokenSnap.exists || !tokenSnap.data().fcmToken) return;

    const senderSnap = await db.doc(`users/${msg.senderId}`).get();
    const senderUsername = senderSnap.exists ? senderSnap.data().username : "contact";

    // Data-only high-priority payload keeps wake-up tiny and protects E2EE privacy
    await getMessaging().send({
      token: tokenSnap.data().fcmToken,
      data: {
        c: event.params.conversationId,
        m: event.params.messageId,
        s: senderUsername,
        t: String(msg.timestamp || Date.now())
      },
      android: {
        priority: "high",
        ttl: 3600 * 1000
      }
    });
  }
);
