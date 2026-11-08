'use strict';
// Stable persisted network identifiers. MTN South Sudan has its own reference
// namespace and wallets; it must not be folded into the existing MTN network.
const networks=Object.freeze(['MTN','MTN SSD','Airtel','Africell','M-Pesa']);
const smsNetworks=Object.freeze(['MTN','MTN SSD','Airtel','M-Pesa']);
function networkLabel(network){return network==='MTN SSD'?'MTN SSD (South Sudan)':network;}
module.exports={networks,smsNetworks,networkLabel};
