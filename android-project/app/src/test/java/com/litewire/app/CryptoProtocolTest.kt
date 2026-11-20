package com.litewire.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class CryptoProtocolTest {

    @Test
    fun ecdhHkdfAesGcmRoundTripProducesIdenticalPlaintext() {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val alice = kpg.generateKeyPair()
        val bob = kpg.generateKeyPair()

        val aliceAgreement = KeyAgreement.getInstance("ECDH")
        aliceAgreement.init(alice.private)
        aliceAgreement.doPhase(bob.public, true)
        val secretA = aliceAgreement.generateSecret()

        val bobAgreement = KeyAgreement.getInstance("ECDH")
        bobAgreement.init(bob.private)
        bobAgreement.doPhase(alice.public, true)
        val secretB = bobAgreement.generateSecret()

        val convoId = "alice_bob"
        val salt = MessageDigest.getInstance("SHA-256")
            .digest("litewire-e2ee-v1:$convoId".toByteArray(StandardCharsets.UTF_8))

        fun hkdf(secret: ByteArray): SecretKeySpec {
            val prkMac = Mac.getInstance("HmacSHA256")
            prkMac.init(SecretKeySpec(salt, "HmacSHA256"))
            val prk = prkMac.doFinal(secret)
            val expMac = Mac.getInstance("HmacSHA256")
            expMac.init(SecretKeySpec(prk, "HmacSHA256"))
            val okm = expMac.doFinal("AES-256-GCM".toByteArray(StandardCharsets.UTF_8) + byteArrayOf(0x01))
            return SecretKeySpec(okm, "AES")
        }

        val keyA = hkdf(secretA)
        val keyB = hkdf(secretB)

        val iv = ByteArray(12) { it.toByte() }
        val message = "Low-data encrypted test message!"

        val encCipher = Cipher.getInstance("AES/GCM/NoPadding")
        encCipher.init(Cipher.ENCRYPT_MODE, keyA, GCMParameterSpec(128, iv))
        encCipher.updateAAD(convoId.toByteArray(StandardCharsets.UTF_8))
        val ciphertext = encCipher.doFinal(message.toByteArray(StandardCharsets.UTF_8))

        assertNotEquals(message, String(ciphertext, StandardCharsets.UTF_8))

        val decCipher = Cipher.getInstance("AES/GCM/NoPadding")
        decCipher.init(Cipher.DECRYPT_MODE, keyB, GCMParameterSpec(128, iv))
        decCipher.updateAAD(convoId.toByteArray(StandardCharsets.UTF_8))
        val decrypted = String(decCipher.doFinal(ciphertext), StandardCharsets.UTF_8)

        assertEquals(message, decrypted)
    }
}
