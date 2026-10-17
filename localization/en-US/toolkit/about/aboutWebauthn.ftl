

about-webauthn-page-title = About WebAuthn


about-webauthn-info-section-title = Device info
about-webauthn-info-subsection-title = Authenticator info
about-webauthn-options-subsection-title = Authenticator options
about-webauthn-pin-section-title = PIN Management
about-webauthn-credential-management-section-title = Manage credentials
about-webauthn-pin-required-section-title = PIN required
about-webauthn-confirm-deletion-section-title = Confirm deletion
about-webauthn-bio-enrollment-section-title = Biometric enrollments


about-webauthn-text-connect-device = Please connect a security token.
about-webauthn-text-select-device = Please select your desired security token by touching the device.
about-webauthn-text-non-ctap2-device = Unable to manage options because your security token does not support CTAP2.
about-webauthn-text-not-available = Not available on this platform.
about-webauthn-bio-enrollment-list-subsection-title = Enrollments:
about-webauthn-add-bio-enrollment-section-title = Add new enrollment


about-webauthn-results-success = Success!
about-webauthn-results-general-error = Error!
about-webauthn-results-pin-invalid-error =
    { $retriesLeft ->
        [0] Error: Incorrect PIN. Try again.
        [one] Error: Incorrect PIN. Try again. You have one attempt left.
       *[other] Error: Incorrect PIN. Try again. You have { $retriesLeft } attempts left.
    }
about-webauthn-results-pin-blocked-error = Error: There are no attempts left and your device has been locked, because the wrong PIN was provided too many times. The device needs a reset.
about-webauthn-results-pin-not-set-error = Error: PIN not set. This operation needs PIN protection.
about-webauthn-results-pin-too-short-error = Error: The given PIN is too short.
about-webauthn-results-pin-too-long-error = Error: The given PIN is too long.
about-webauthn-results-pin-auth-blocked-error = Error: There were too many failed attempts in a row and PIN authentication has been temporarily blocked. Your device needs a power cycle (unplug and re-insert).
about-webauthn-results-cancelled-by-user-error = Error: Operation has been canceled by the user.


about-webauthn-new-pin-label = New PIN:
about-webauthn-repeat-pin-label = Repeat new PIN:
about-webauthn-current-pin-label = Current PIN:
about-webauthn-pin-required-label = Please enter your PIN:
about-webauthn-credential-list-subsection-title = Credentials:
about-webauthn-enrollment-name-label = Enrollment name (optional):
about-webauthn-enrollment-list-empty = No enrollments found on device.
about-webauthn-credential-list-empty = No credentials found on device.
about-webauthn-confirm-deletion-label = You are about to delete:


about-webauthn-current-set-pin-button = Set PIN
about-webauthn-current-change-pin-button = Change PIN
about-webauthn-list-credentials-button = List credentials
about-webauthn-list-bio-enrollments-button = List enrollments
about-webauthn-add-bio-enrollment-button = Add enrollment
about-webauthn-cancel-button = Cancel
about-webauthn-send-pin-button = OK
about-webauthn-delete-button = Delete
about-webauthn-start-enrollment-button = Start enrollment
about-webauthn-update-button = Update


about-webauthn-auth-option-uv = User verification
about-webauthn-auth-option-up = User presence
about-webauthn-auth-option-clientpin = Client PIN
about-webauthn-auth-option-rk = Resident key
about-webauthn-auth-option-plat = Platform device
about-webauthn-auth-option-pinuvauthtoken = Command permissions (pinUvAuthToken)
about-webauthn-auth-option-nomcgapermissionswithclientpin = No MakeCredential / GetAssertion permissions with client PIN
about-webauthn-auth-option-largeblobs = Large blobs
about-webauthn-auth-option-ep = Enterprise attestation
about-webauthn-auth-option-bioenroll = Biometric enrollment
about-webauthn-auth-option-userverificationmgmtpreview = Prototype of biometric enrollment (FIDO_2_1_PRE)
about-webauthn-auth-option-uvbioenroll = Biometric enrollment permission
about-webauthn-auth-option-authnrcfg = Authenticator config
about-webauthn-auth-option-uvacfg = Authenticator config permission
about-webauthn-auth-option-credmgmt = Credential management
about-webauthn-auth-option-credentialmgmtpreview = Prototype credential management
about-webauthn-auth-option-setminpinlength = Set minimum PIN length
about-webauthn-auth-option-makecreduvnotrqd = MakeCredential without user verification
about-webauthn-auth-option-alwaysuv = Always require user verification
about-webauthn-auth-option-true = True
about-webauthn-auth-option-false = False
about-webauthn-auth-option-null = Not supported


about-webauthn-auth-info-vendor-prototype-config-commands = Vendor prototype config commands
about-webauthn-auth-info-remaining-discoverable-credentials = Remaining discoverable credentials
about-webauthn-auth-info-certifications = Certifications
about-webauthn-auth-info-uv-modality = User verification modality
about-webauthn-auth-info-preferred-platform-uv-attempts = Preferred platform user verification attempts
about-webauthn-auth-info-max-rpids-for-set-min-pin-length = Max relying party IDs for set minimum PIN length
about-webauthn-auth-info-max-cred-blob-length = Max credential blob length
about-webauthn-auth-info-firmware-version = Firmware version
about-webauthn-auth-info-min-pin-length = Minimum PIN length
about-webauthn-auth-info-force-pin-change = Force PIN change
about-webauthn-auth-info-max-ser-large-blob-array = Max size of large blob array
about-webauthn-auth-info-algorithms = Algorithms
about-webauthn-auth-info-transports = Transports
about-webauthn-auth-info-max-credential-id-length = Max credential ID length
about-webauthn-auth-info-max-credential-count-in-list = Max credential count in list
about-webauthn-auth-info-pin-protocols = PIN protocols
about-webauthn-auth-info-max-msg-size = Max message size
about-webauthn-auth-info-aaguid = AAGUID
about-webauthn-auth-info-extensions = Extensions
about-webauthn-auth-info-versions = Versions
about-webauthn-auth-info-true = True
about-webauthn-auth-info-false = False
about-webauthn-auth-info-null = Not supported


about-webauthn-samples-still-needed =
    { $repeatCount ->
        [one] { $repeatCount } sample still needed.
       *[other] { $repeatCount } samples still needed.
    }

about-webauthn-ctap2-enroll-feedback-good = Sample was good.


about-webauthn-ctap2-enroll-feedback-too-high = Sample was too high.
about-webauthn-ctap2-enroll-feedback-too-low = Sample was too low.
about-webauthn-ctap2-enroll-feedback-too-left = Sample was too left.
about-webauthn-ctap2-enroll-feedback-too-right = Sample was too right.


about-webauthn-ctap2-enroll-feedback-too-fast = Sample was too fast.
about-webauthn-ctap2-enroll-feedback-too-slow = Sample was too slow.
about-webauthn-ctap2-enroll-feedback-poor-quality = Sample had poor quality.
about-webauthn-ctap2-enroll-feedback-too-skewed = Sample was too skewed.
about-webauthn-ctap2-enroll-feedback-too-short = Sample was too short.
about-webauthn-ctap2-enroll-feedback-merge-failure = Sample merge failure.
about-webauthn-ctap2-enroll-feedback-exists = Sample already exists.
about-webauthn-ctap2-enroll-feedback-no-user-activity = No activity from user.
about-webauthn-ctap2-enroll-feedback-no-user-presence-transition = User did not complete the sampling as expected.
about-webauthn-ctap2-enroll-feedback-other = Sample error.
