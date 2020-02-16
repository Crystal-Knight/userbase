import uuidv4 from 'uuid/v4'
import connection from './connection'
import logger from './logger'
import statusCodes from './statusCodes'
import setup from './setup'
import userController from './user'

async function createApp(appName, adminId, appId = uuidv4()) {
  if (!appName || !adminId) throw {
    status: statusCodes['Bad Request'],
    data: 'Missing required items'
  }

  try {
    const trimmedAppName = appName.trim()
    if (!trimmedAppName) throw {
      status: statusCodes['Bad Request'],
      data: 'App name cannot be blank'
    }

    const app = {
      'admin-id': adminId,
      'app-name': trimmedAppName,
      'app-id': appId,
      'creation-date': new Date().toISOString(),
    }

    const params = {
      TableName: setup.appsTableName,
      Item: app,
      ConditionExpression: 'attribute_not_exists(#adminId)',
      ExpressionAttributeNames: {
        '#adminId': 'admin-id'
      },
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.put(params).promise()
    return app
  } catch (e) {
    if (e.data === 'App name cannot be blank') throw e
    if (e.name === 'ConditionalCheckFailedException') {
      throw {
        status: statusCodes['Conflict'],
        data: 'App already exists'
      }
    } else {
      logger.error(`Failed to create app ${appName} for admin ${adminId} with ${e}`)
      throw {
        status: statusCodes['Internal Server Error'],
        data: 'Failed to create app'
      }
    }
  }
}
exports.createApp = createApp

exports.createAppController = async function (req, res) {
  const subscription = res.locals.subscription

  if (!subscription || subscription.cancel_at_period_end || subscription.status !== 'active') return res
    .status(statusCodes['Payment Required'])
    .send('Pay subscription fee to create an app.')

  const appName = req.body.appName

  const admin = res.locals.admin
  const adminId = admin['admin-id']

  try {
    const app = await createApp(appName, adminId)
    return res.send(app)
  } catch (e) {
    return res
      .status(e.status)
      .send(e.data)
  }
}

exports.listApps = async function (req, res) {
  const admin = res.locals.admin
  const adminId = admin['admin-id']

  const params = {
    TableName: setup.appsTableName,
    KeyConditionExpression: '#adminId = :adminId',
    ExpressionAttributeNames: {
      '#adminId': 'admin-id'
    },
    ExpressionAttributeValues: {
      ':adminId': adminId
    }
  }

  try {
    const ddbClient = connection.ddbClient()

    let appsResponse = await ddbClient.query(params).promise()
    let apps = appsResponse.Items

    while (appsResponse.LastEvaluatedKey) {
      params.ExclusiveStartKey = appsResponse.LastEvaluatedKey
      appsResponse = await ddbClient.query(params).promise()
      apps.push(appsResponse.Items)
    }

    return res.status(statusCodes['Success']).send(apps)
  } catch (e) {
    logger.error(`Failed to list apps with ${e}`)
    return res
      .status(statusCodes['Internal Server Error'])
      .send('Failed to list apps')
  }
}

async function getApp(adminId, appName) {
  const params = {
    TableName: setup.appsTableName,
    Key: {
      'admin-id': adminId,
      'app-name': appName
    }
  }

  const ddbClient = connection.ddbClient()
  const appResponse = await ddbClient.get(params).promise()
  return appResponse.Item
}
exports.getApp = getApp

async function getAppByAppId(appId) {
  const params = {
    TableName: setup.appsTableName,
    IndexName: setup.appIdIndex,
    KeyConditionExpression: '#appId = :appId',
    ExpressionAttributeNames: {
      '#appId': 'app-id'
    },
    ExpressionAttributeValues: {
      ':appId': appId
    },
    Select: 'ALL_ATTRIBUTES'
  }

  const ddbClient = connection.ddbClient()
  const appResponse = await ddbClient.query(params).promise()

  if (!appResponse || appResponse.Items.length === 0) return null

  if (appResponse.Items.length > 1) {
    // too sensitive not to throw here. This should never happen
    const errorMsg = `Too many apps found with app id ${appId}`
    logger.fatal(errorMsg)
    throw new Error(errorMsg)
  }

  return appResponse.Items[0]
}
exports.getAppByAppId = getAppByAppId

exports.deleteApp = async function (req, res) {
  const subscription = res.locals.subscription

  if (!subscription || subscription.cancel_at_period_end || subscription.status !== 'active') return res
    .status(statusCodes['Payment Required'])
    .send('Pay subscription fee to delete an app.')

  const appName = req.body.appName

  const admin = res.locals.admin
  const adminId = admin['admin-id']

  if (!appName || !adminId) return res
    .status(statusCodes['Bad Request'])
    .send('Missing required items')

  try {
    const params = {
      TableName: setup.appsTableName,
      Key: {
        'admin-id': adminId,
        'app-name': appName
      },
      UpdateExpression: 'SET deleted = :deleted',
      ConditionExpression: 'attribute_exists(#adminId) and attribute_not_exists(deleted)',
      ExpressionAttributeValues: {
        ':deleted': new Date().toISOString()
      },
      ExpressionAttributeNames: {
        '#adminId': 'admin-id'
      }
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    return res.end()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return res.status(statusCodes['Not Found']).send('App not found')
    }

    logger.error(`Failed to delete app ${appName} for admin ${adminId} with ${e}`)
    return res.status(statusCodes['Internal Server Error']).send('Failed to delete app')
  }
}

exports.permanentDeleteApp = async function (req, res) {
  const subscription = res.locals.subscription

  if (!subscription || subscription.cancel_at_period_end || subscription.status !== 'active') return res
    .status(statusCodes['Payment Required'])
    .send('Pay subscription fee to permanently delete an app.')

  const appName = req.body.appName
  const appId = req.body.appId

  const admin = res.locals.admin
  const adminId = admin['admin-id']

  if (!appName || !appId || !adminId) return res
    .status(statusCodes['Bad Request'])
    .send('Missing required items')

  try {
    const existingAppParams = {
      TableName: setup.appsTableName,
      Key: {
        'admin-id': adminId,
        'app-name': appName
      },
      ConditionExpression: 'attribute_exists(deleted) and #appId = :appId',
      ExpressionAttributeNames: {
        '#appId': 'app-id'
      },
      ExpressionAttributeValues: {
        ':appId': appId
      }
    }

    const permanentDeletedAppParams = {
      TableName: setup.deletedAppsTableName,
      Item: {
        'app-id': appId,
        'admin-id': adminId,
        'app-name': appName
      },
      ConditionExpression: 'attribute_not_exists(#appId)',
      ExpressionAttributeNames: {
        '#appId': 'app-id'
      },
    }

    const transactionParams = {
      TransactItems: [
        { Delete: existingAppParams },
        { Put: permanentDeletedAppParams }
      ]
    }

    const ddbClient = connection.ddbClient()
    await ddbClient.transactWrite(transactionParams).promise()

    return res.end()
  } catch (e) {
    if (e.message.includes('ConditionalCheckFailed]')) {
      return res.status(statusCodes['Conflict']).send('App already permanently deleted')
    }

    logger.error(`Failed to permanently delete app ${appName} for admin ${adminId} with ${e}`)
    return res.status(statusCodes['Internal Server Error']).send('Failed to permanently delete app')
  }
}

exports.listAppUsers = async function (req, res) {
  const appName = req.body.appName

  const admin = res.locals.admin
  const adminId = admin['admin-id']

  try {
    const app = await getApp(adminId, appName)
    if (!app || app['deleted']) return res.status(statusCodes['Not Found']).send('App not found')

    const params = {
      TableName: setup.usersTableName,
      IndexName: setup.appIdIndex,
      KeyConditionExpression: '#appId = :appId',
      ExpressionAttributeNames: {
        '#appId': 'app-id'
      },
      ExpressionAttributeValues: {
        ':appId': app['app-id']
      }
    }

    const ddbClient = connection.ddbClient()

    let usersResponse = await ddbClient.query(params).promise()
    let users = usersResponse.Items

    while (usersResponse.LastEvaluatedKey) {
      params.ExclusiveStartKey = usersResponse.LastEvaluatedKey
      usersResponse = await ddbClient.query(params).promise()
      users.push(usersResponse.Items)
    }

    return res.status(statusCodes['Success']).send({
      users: users.map(user => userController.buildUserResult(user)),
      appId: app['app-id']
    })
  } catch (e) {
    logger.error(`Failed to list app users for app ${appName} and admin ${adminId} with ${e}`)
    return res
      .status(statusCodes['Internal Server Error'])
      .send('Failed to list app users')
  }
}

exports.countNonDeletedAppUsers = async function (appId, limit) {
  const params = {
    TableName: setup.usersTableName,
    IndexName: setup.appIdIndex,
    KeyConditionExpression: '#appId = :appId',
    FilterExpression: 'attribute_not_exists(deleted) and attribute_not_exists(#seedNotSavedYet)',
    ExpressionAttributeNames: {
      '#appId': 'app-id',
      '#seedNotSavedYet': 'seed-not-saved-yet'
    },
    ExpressionAttributeValues: {
      ':appId': appId
    },
    Select: 'COUNT'
  }

  if (limit) params.Limit = limit

  const ddbClient = connection.ddbClient()

  let usersResponse = await ddbClient.query(params).promise()
  let count = usersResponse.Count

  // limit stops query as soon as limit number of items are read, not necessarily items that fit filter expression.
  // must continue executing query until limit is reached or read all items in table
  while ((!limit || count < limit) && usersResponse.LastEvaluatedKey) {
    params.ExclusiveStartKey = usersResponse.LastEvaluatedKey
    usersResponse = await ddbClient.query(params).promise()
    count = limit
      ? Math.min(limit, count + usersResponse.Count)
      : count + usersResponse.Count
  }

  return count
}
