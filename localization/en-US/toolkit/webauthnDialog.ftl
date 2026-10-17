
webauthn-pin-invalid-long-prompt =
    { $retriesLeft ->
        [one] Incorrect PIN. You have { $retriesLeft } attempt left before you permanently lose access to the credentials on this device.
       *[other] Incorrect PIN. You have { $retriesLeft } attempts left before you permanently lose access to the credentials on this device.
    }
webauthn-pin-invalid-short-prompt = Incorrect PIN. Try again.
webauthn-pin-required-prompt = Please enter the PIN for your device.

webauthn-select-sign-result-unknown-account = Unknown account

webauthn-a-passkey-label = Use a passkey
webauthn-another-passkey-label = Use another passkey

webauthn-specific-passkey-label = Passkey for { $domain }

webauthn-uv-invalid-long-prompt =
    { $retriesLeft ->
        [one] User verification failed. You have { $retriesLeft } attempt left. Try again.
       *[other] User verification failed. You have { $retriesLeft } attempts left. Try again.
    }
webauthn-uv-invalid-short-prompt = User verification failed. Try again.


webauthn-user-presence-prompt = Touch your security key to continue with { $hostname }.
webauthn-register-direct-prompt =
    { $hostname } is requesting extended information about your security key, which may affect your privacy.
webauthn-register-direct-prompt-hint =
    { -brand-short-name } can anonymize this for you, but the website might decline this key. If declined, you can try again.
webauthn-select-sign-result-prompt =
    Multiple accounts found for { $hostname }. Select which to use or cancel.
webauthn-select-device-prompt =
    Multiple devices found for { $hostname }. Please select one.
webauthn-device-blocked-prompt =
    User verification failed on { $hostname }. There are no attempts left and your device has been locked, because the wrong PIN was provided too many times. The device needs a reset.
webauthn-pin-auth-blocked-prompt =
    User verification failed on { $hostname }. There were too many failed attempts in a row and PIN authentication has been temporarily blocked. Your device needs a power cycle (unplug and re-insert).
webauthn-pin-not-set-prompt =
    User verification failed on { $hostname }. You may need to set a PIN on your device.
webauthn-uv-blocked-prompt =
    User verification failed on { $hostname }. There were too many failed attempts and the built-in user verification method has been blocked.
webauthn-already-registered-prompt =
    This device is already registered. Try a different device.
webauthn-cancel = Cancel
    .accesskey = c
webauthn-allow = Allow
    .accesskey = A
webauthn-block = Block
    .accesskey = B
webauthn-continue = Continue
    .accesskey = n

webauthn-related-origin-create-header = { $origin } wants to create a passkey for { $rpId }.
webauthn-related-origin-use-header = { $origin } wants to use a passkey for { $rpId }.
