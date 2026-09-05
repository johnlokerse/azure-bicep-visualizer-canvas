param location string

resource accounts 'Microsoft.Storage/storageAccounts@2023-05-01' = [for index in range(0, 2): {
  name: 'example${index}${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    supportsHttpsTrafficOnly: true
  }
}]
