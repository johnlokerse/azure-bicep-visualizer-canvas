param location string = resourceGroup().location

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'example-network'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
  }
}

module storage './storage.bicep' = {
  name: 'example-storage'
  params: {
    location: location
  }
  dependsOn: [
    network
  ]
}
