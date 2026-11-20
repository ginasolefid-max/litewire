package com.litewire.app.crypto

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class EncryptedPayload(
    val ciphertext: String,
    val iv: String
)

/**
 * End-to-End Encryption manager using:
 * - ECDH on NIST P-256 (secp256r1) for asynchronous shared secret agreement
 * - HKDF-SHA256 (RFC 5869) bound to conversationId for 256-bit key derivation
 * - AES-256-GCM with fresh 96-bit CSPRNG IV per message
 * - Android Keystore MasterKey + EncryptedSharedPreferences for private key persistence
 */
class CryptoManager(context: Context) {

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val securePrefs = EncryptedSharedPreferences.create(
        context,
        "litewire_keystore_vault",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val secureRandom = SecureRandom()

    fun getOrCreatePublicKeyBase64(uid: String): String {
        val existingPub = securePrefs.getString("pub_$uid", null)
        val existingPriv = securePrefs.getString("priv_$uid", null)
        if (existingPub != null && existingPriv != null) {
            return existingPub
        }

        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"), secureRandom)
        val keyPair = kpg.generateKeyPair()

        val pubB64 = Base64.encodeToString(keyPair.public.encoded, Base64.NO_WRAP)
        val privB64 = Base64.encodeToString(keyPair.private.encoded, Base64.NO_WRAP)

        securePrefs.edit()
            .putString("pub_$uid", pubB64)
            .putString("priv_$uid", privB64)
            .apply()

        return pubB64
    }

    fun hasPrivateKey(uid: String): Boolean {
        return securePrefs.getString("priv_$uid", null) != null
    }

    private fun loadPrivateKey(uid: String): PrivateKey {
        val privB64 = securePrefs.getString("priv_$uid", null)
            ?: throw IllegalStateException("Identity private key missing for $uid")
        val bytes = Base64.decode(privB64, Base64.NO_WRAP)
        return KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes))
    }

    private fun decodePublicKey(pubB64: String): PublicKey {
        val bytes = Base64.decode(pubB64, Base64.NO_WRAP)
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes))
    }

    private fun deriveConversationAesKey(
        myUid: String,
        peerPublicKeyBase64: String,
        conversationId: String
    ): SecretKeySpec {
        val privKey = loadPrivateKey(myUid)
        val peerPub = decodePublicKey(peerPublicKeyBase64)

        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privKey)
        agreement.doPhase(peerPub, true)
        val sharedSecret = agreement.generateSecret()

        // HKDF-SHA256 Extract + Expand (RFC 5869)
        val salt = MessageDigest.getInstance("SHA-256")
            .digest("litewire-e2ee-v1:$conversationId".toByteArray(StandardCharsets.UTF_8))
        val prkMac = Mac.getInstance("HmacSHA256")
        prkMac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = prkMac.doFinal(sharedSecret)

        val expandMac = Mac.getInstance("HmacSHA256")
        expandMac.init(SecretKeySpec(prk, "HmacSHA256"))
        val info = "AES-256-GCM".toByteArray(StandardCharsets.UTF_8) + byteArrayOf(0x01)
        val okm = expandMac.doFinal(info) // 32 bytes = 256-bit AES key

        return SecretKeySpec(okm, "AES")
    }

    fun encrypt(
        myUid: String,
        peerPublicKeyBase64: String,
        conversationId: String,
        plaintext: String
    ): EncryptedPayload {
        val aesKey = deriveConversationAesKey(myUid, peerPublicKeyBase64, conversationId)
        val iv = ByteArray(12)
        secureRandom.nextBytes(iv)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
        cipher.updateAAD(conversationId.toByteArray(StandardCharsets.UTF_8))
        val ctBytes = cipher.doFinal(plaintext.toByteArray(StandardCharsets.UTF_8))

        return EncryptedPayload(
            ciphertext = Base64.encodeToString(ctBytes, Base64.NO_WRAP),
            iv = Base64.encodeToString(iv, Base64.NO_WRAP)
        )
    }

    fun decrypt(
        myUid: String,
        peerPublicKeyBase64: String,
        conversationId: String,
        ciphertextBase64: String,
        ivBase64: String
    ): String {
        val aesKey = deriveConversationAesKey(myUid, peerPublicKeyBase64, conversationId)
        val iv = Base64.decode(ivBase64, Base64.NO_WRAP)
        val ctBytes = Base64.decode(ciphertextBase64, Base64.NO_WRAP)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
        cipher.updateAAD(conversationId.toByteArray(StandardCharsets.UTF_8))
        val plainBytes = cipher.doFinal(ctBytes)
        return String(plainBytes, StandardCharsets.UTF_8)
    }

    fun computeSafetyFingerprint(pubKeyA: String, pubKeyB: String): String {
        val sorted = listOf(pubKeyA, pubKeyB).sorted().joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(sorted.toByteArray(StandardCharsets.UTF_8))
        return digest.take(16).joinToString("") { "%02X".format(it) }
            .chunked(4)
            .joinToString(" ")
    }

    fun clearKeys() {
        securePrefs.edit().clear().apply()
    }
}
