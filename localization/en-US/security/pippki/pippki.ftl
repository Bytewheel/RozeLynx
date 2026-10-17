
password-quality-meter = Password quality meter


change-device-password-window =
  .title = Change Password

change-password-token = Security Device: { $tokenName }
change-password-old = Current password:
change-password-new = New password:
change-password-reenter = New password (again):

pippki-failed-pw-change = Unable to change password.
pippki-incorrect-pw = You did not enter the correct current password. Please try again.
pippki-pw-change-ok = Password successfully changed.

pippki-pw-empty-warning = Your stored passwords and private keys will not be protected.
pippki-pw-erased-ok = You have deleted your password. { pippki-pw-empty-warning }
pippki-pw-not-wanted = Warning! You have decided not to use a password. { pippki-pw-empty-warning }

pippki-pw-change2empty-in-fips-mode = You are currently in FIPS mode. FIPS requires a non-empty password.


reset-primary-password-window2 =
  .title = Reset Primary Password
  .style = min-width: 40em
reset-password-button-label =
  .label = Reset
reset-primary-password-text = If you reset your Primary Password, all your stored web and e-mail passwords, personal certificates, and private keys will be forgotten. Are you sure you want to reset your Primary Password?

pippki-reset-password-confirmation-title = Reset Primary Password
pippki-reset-password-confirmation-message = Your Primary Password has been reset.


download-cert-window2 =
  .title = Downloading Certificate
  .style = min-width: 46em
download-cert-message = You have been asked to trust a new Certificate Authority (CA).
download-cert-trust-ssl =
  .label = Trust this CA to identify websites.
download-cert-trust-email =
  .label = Trust this CA to identify email users.
download-cert-message-desc = Before trusting this CA for any purpose, you should examine its certificate and its policy and procedures (if available).
download-cert-view-cert =
  .label = View
download-cert-view-text = Examine CA certificate


client-auth-window =
  .title = User Identification Request
client-auth-send-no-certificate =
  .label = Don’t send a certificate

client-auth-site-identification = “{ $hostname }” has requested that you identify yourself with a certificate:
client-auth-cert-details = Details of selected certificate:
client-auth-cert-details-issued-to = Issued to: { $issuedTo }
client-auth-cert-details-serial-number = Serial number: { $serialNumber }
client-auth-cert-details-validity-period = Valid from { $notBefore } to { $notAfter }
client-auth-cert-details-key-usages = Key usages: { $keyUsages }
client-auth-cert-details-email-addresses = Email addresses: { $emailAddresses }
client-auth-cert-details-issued-by = Issued by: { $issuedBy }
client-auth-cert-details-stored-on = Stored on: { $storedOn }

client-auth-cert-remember-label = Remember this decision:
client-auth-cert-remember-never =
  .label = Once
client-auth-cert-remember-always =
  .label = Permanently
client-auth-cert-remember-temporarily =
  .label = For this session


set-password-window =
  .title = Choose a Certificate Backup Password
set-password-message = The certificate backup password you set here protects the backup file that you are about to create. You must set this password to proceed with the backup.
set-password-backup-pw =
  .value = Certificate backup password:
set-password-repeat-backup-pw =
  .value = Certificate backup password (again):
set-password-reminder = Important: If you forget your certificate backup password, you will not be able to restore this backup later. Please record it in a safe location.


protected-auth-window =
  .title = Protected Authentication

protected-auth-prompt = Please authenticate to the security device ({ $tokenName }). How to do so depends on the device (for example, using a fingerprint reader or entering a code with a keypad).
