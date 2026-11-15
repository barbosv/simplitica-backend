"""Synthetic profile fixtures only. No Apple trust or device evidence.
Run with Python 3 and cryptography 50.0.2. Private keys are discarded.
"""
from pathlib import Path
import base64, datetime, json
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID, ObjectIdentifier

UTC = datetime.timezone.utc
BEFORE = datetime.datetime(2024, 1, 1, tzinfo=UTC)
AFTER = datetime.datetime(2025, 1, 1, tzinfo=UTC)
nonce_oid = ObjectIdentifier('1.2.840.113635.100.8.2')
issuer_key = ec.generate_private_key(ec.SECP384R1())
leaf_key = ec.generate_private_key(ec.SECP256R1())
issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Synthetic App Attest issuer')])
subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Synthetic App Attest leaf')])

def make(*, ca=False, digital=True, signing=False, nonce=bytes.fromhex('3024a1220420') + bytes(32), critical=False, key=leaf_key, digest=None, eku=None):
    b = (x509.CertificateBuilder().subject_name(issuer if ca else subject).issuer_name(issuer)
         .public_key(key.public_key()).serial_number(x509.random_serial_number())
         .not_valid_before(BEFORE).not_valid_after(AFTER)
         .add_extension(x509.BasicConstraints(ca=ca, path_length=0 if ca else None), True)
         .add_extension(x509.KeyUsage(digital_signature=digital, content_commitment=False,
            key_encipherment=False, data_encipherment=False, key_agreement=False,
            key_cert_sign=signing, crl_sign=signing, encipher_only=None, decipher_only=None), True))
    if nonce is not None:
        b = b.add_extension(x509.UnrecognizedExtension(nonce_oid, nonce), False)
    if critical:
        b = b.add_extension(x509.UnrecognizedExtension(ObjectIdentifier('1.2.3.4'), b'\x05\x00'), True)
    if eku is not None:
        b = b.add_extension(x509.ExtendedKeyUsage([ObjectIdentifier(eku)]), False)
    return b.sign(issuer_key, digest or hashes.SHA256())

valid = make()
variants = {
    'validLeaf': valid,
    'validIssuer': make(ca=True, signing=True, nonce=None, key=issuer_key, digest=hashes.SHA384()),
    'leafAsCA': make(ca=True, signing=True),
    'missingDigitalSignature': make(digital=False),
    'leafSigningCertificates': make(signing=True),
    'caMissingKeyCertSign': make(ca=True, nonce=None),
    'unknownCriticalExtension': make(critical=True),
    'nonceWrongTag': make(nonce=bytes.fromhex('3024a2220420') + bytes(32)),
    'nonceWrongLength': make(nonce=bytes.fromhex('3023a121041f') + bytes(31)),
    'nonceTrailing': make(nonce=bytes.fromhex('3024a1220420') + bytes(32) + b'\x05\x00'),
    'nonceMissing': make(nonce=None),
    'unsupportedPublicKey': make(key=rsa.generate_private_key(public_exponent=65537, key_size=2048)),
    'unsupportedCurve': make(key=ec.generate_private_key(ec.SECP521R1())),
    'unsupportedSignature': make(digest=hashes.SHA224()),
    'invalidExtendedUsage': make(eku='1.3.6.1.5.5.7.3.1'),
}
encode = lambda c: base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()
pub = leaf_key.public_key().public_numbers()
data = {name: encode(cert) for name, cert in variants.items()}
data['x'] = pub.x.to_bytes(32, 'big').hex()
data['y'] = pub.y.to_bytes(32, 'big').hex()
Path(__file__).with_name('synthetic-certificates.json').write_text(json.dumps(data, indent=2) + '\n')
