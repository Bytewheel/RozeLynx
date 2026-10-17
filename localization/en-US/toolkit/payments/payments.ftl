

credit-card-expiration = Expires on { $month }/{ $year }


credit-card-label-number-2 = { $number }
    .aria-label = { $type } { credit-card-label-number-2 }

credit-card-label-number-name-2 = { $number }, { $name }
    .aria-label = { $type } { credit-card-label-number-name-2 }

credit-card-label-number-expiration-2 = { $number }, { credit-card-expiration }
    .aria-label = { $type } { credit-card-label-number-expiration-2 }

credit-card-label-number-name-expiration-2 =
  { $number }, { $name }, { credit-card-expiration }
    .aria-label = { $type } { credit-card-label-number-name-expiration-2 }

credit-card-label-with-security-code = { $label } | CVV saved
    .aria-label = { $ariaLabel }, CVV saved
