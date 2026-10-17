
csp-error-missing-directive = Policy is missing a required ‘{ $directive }’ directive

csp-error-illegal-keyword = ‘{ $directive }’ directive contains a forbidden { $keyword } keyword

csp-error-illegal-protocol = ‘{ $directive }’ directive contains a forbidden { $scheme }: protocol source

csp-error-missing-host = { $scheme }: protocol requires a host in ‘{ $directive }’ directives

csp-error-missing-source = ‘{ $directive }’ must include the source { $source }

csp-error-illegal-host-wildcard = { $scheme }: wildcard sources in ‘{ $directive }’ directives must include at least one non-generic sub-domain (e.g., *.example.com rather than *.com)
