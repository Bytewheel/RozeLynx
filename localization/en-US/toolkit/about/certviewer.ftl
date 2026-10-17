
certificate-viewer-certificate-section-title = Certificate


certificate-viewer-error-message = We were unable to find the certificate information, or the certificate is corrupted. Please try again.
certificate-viewer-error-title = Something went wrong.


certificate-viewer-algorithm = Algorithm
certificate-viewer-certificate-authority = Certificate Authority
certificate-viewer-cipher-suite = Cipher Suite
certificate-viewer-common-name = Common Name
certificate-viewer-email-address = Email Address
certificate-viewer-tab-title = Certificate for { $firstCertName }
certificate-viewer-inc-country = Inc. Country
certificate-viewer-country = Country
certificate-viewer-curve = Curve
certificate-viewer-distribution-point = Distribution Point
certificate-viewer-dns-name = DNS Name
certificate-viewer-ip-address = IP Address
certificate-viewer-other-name = Other Name
certificate-viewer-exponent = Exponent
certificate-viewer-id = ID
certificate-viewer-key-exchange-group = Key Exchange Group
certificate-viewer-key-id = Key ID
certificate-viewer-key-size = Key Size
certificate-viewer-inc-locality = Inc. Locality
certificate-viewer-locality = Locality
certificate-viewer-location = Location
certificate-viewer-log-name = Log Name
certificate-viewer-logid = Log ID
certificate-viewer-method = Method
certificate-viewer-modulus = Modulus
certificate-viewer-name = Name
certificate-viewer-surname = Surname
certificate-viewer-given-name = Given Name
certificate-viewer-not-after = Not After
certificate-viewer-not-before = Not Before
certificate-viewer-organization = Organization
certificate-viewer-organizational-unit = Organizational Unit
certificate-viewer-policy = Policy
certificate-viewer-protocol = Protocol
certificate-viewer-public-value = Public Value
certificate-viewer-purposes = Purposes
certificate-viewer-qualifier = Qualifier
certificate-viewer-qualifiers = Qualifiers
certificate-viewer-required = Required
certificate-viewer-unsupported = &lt;unsupported&gt;
certificate-viewer-inc-state-province = Inc. State/Province
certificate-viewer-state-province = State/Province
certificate-viewer-sha-1 = SHA-1
certificate-viewer-sha-256 = SHA-256
certificate-viewer-serial-number = Serial Number
certificate-viewer-signature-algorithm = Signature Algorithm
certificate-viewer-signature-scheme = Signature Scheme
certificate-viewer-timestamp = Timestamp
certificate-viewer-value = Value
certificate-viewer-version = Version
certificate-viewer-business-category = Business Category
certificate-viewer-subject-name = Subject Name
certificate-viewer-issuer-name = Issuer Name
certificate-viewer-validity = Validity
certificate-viewer-subject-alt-names = Subject Alt Names
certificate-viewer-public-key-info = Public Key Info
certificate-viewer-miscellaneous = Miscellaneous
certificate-viewer-fingerprints = Fingerprints
certificate-viewer-basic-constraints = Basic Constraints
certificate-viewer-key-usages = Key Usages
certificate-viewer-extended-key-usages = Extended Key Usages
certificate-viewer-ocsp-stapling = OCSP Stapling
certificate-viewer-subject-key-id = Subject Key ID
certificate-viewer-authority-key-id = Authority Key ID
certificate-viewer-authority-info-aia = Authority Info (AIA)
certificate-viewer-certificate-policies = Certificate Policies
certificate-viewer-embedded-scts = Embedded SCTs
certificate-viewer-crl-endpoints = CRL Endpoints

certificate-viewer-download = Download
certificate-viewer-boolean = { $boolean ->
  [true] Yes
 *[false] No
}


certificate-viewer-download-pem = PEM (cert)
  .download = { $fileName }.pem
certificate-viewer-download-pem-chain = PEM (chain)
  .download = { $fileName }-chain.pem

certificate-viewer-critical-extension =
  .title = This extension has been marked as critical, meaning that clients must reject the certificate if they do not understand it.
certificate-viewer-export = Export
  .download = { $fileName }.pem


certificate-viewer-unknown-group-label = (unknown)

certificate-viewer-unknown-file-name = certificate


certificate-viewer-tab-mine = Your Certificates
certificate-viewer-tab-people = People
certificate-viewer-tab-servers = Servers
certificate-viewer-tab-ca = Authorities
