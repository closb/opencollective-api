import Promise from 'bluebird';
import config from 'config';
import { pick } from 'lodash';

import { channels } from '../../../constants';
import { diffDBEntries } from '../../../lib/data';
import models, { Op } from '../../../models';
import { Forbidden, NotFound, Unauthorized } from '../../errors';

const NotificationPermissionError = new Forbidden(
  "This notification does not exist or you don't have the permission to edit it.",
);

const MaxWebhooksExceededError = new Forbidden('You have reached the webhooks limit for this collective.');

/**
 * Edits (by replacing) the admin-level webhooks for a collective.
 */
export async function editWebhooks(args, remoteUser) {
  if (!remoteUser) {
    throw NotificationPermissionError;
  }

  const collective = await models.Collective.findByPk(args.collectiveId);
  if (!collective) {
    throw new Error('Collective not found');
  } else if (!remoteUser.isAdminOfCollective(collective)) {
    throw NotificationPermissionError;
  }

  if (!args.notifications) {
    return Promise.resolve();
  }

  const getAllWebhooks = async () => {
    return await models.Notification.findAll({
      where: { CollectiveId: args.collectiveId, channel: channels.WEBHOOK },
      order: [['createdAt', 'ASC']],
    });
  };

  const allowedFields = ['type', 'webhookUrl'];
  const oldNotifications = await getAllWebhooks();
  const [toCreate, toRemove, toUpdate] = diffDBEntries(oldNotifications, args.notifications, allowedFields);
  const promises = [];

  // Delete old
  if (toRemove.length > 0) {
    promises.push(
      models.Notification.destroy({
        where: { id: { [Op.in]: toRemove.map(n => n.id) } },
      }),
    );
  }

  // Create
  if (toCreate.length > 0) {
    promises.push(
      Promise.all(
        toCreate.map(notification =>
          models.Notification.create({
            ...pick(notification, allowedFields),
            CollectiveId: args.collectiveId,
            UserId: remoteUser.id,
            channel: channels.WEBHOOK,
          }),
        ),
      ),
    );
  }

  // Update existing
  if (toUpdate.length > 0) {
    promises.push(
      ...toUpdate.map(notification => {
        return models.Notification.update(pick(notification, allowedFields), {
          where: { id: notification.id, CollectiveId: args.collectiveId },
        });
      }),
    );
  }

  return Promise.all(promises).then(getAllWebhooks);
}

/**
 * Creates a Webhook subscription for a collective given a collective slug.
 */
export async function createWebhook(args, remoteUser) {
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create a webhook.');
  }

  // Load collective
  const collective = await models.Collective.findOne({ where: { slug: args.collectiveSlug } });
  if (!collective) {
    throw new NotFound(`Collective with slug: ${args.collectiveSlug} not found.`);
  } else if (!remoteUser.isAdmin(collective.id)) {
    throw new Unauthorized('You do not have permissions to create webhooks for this collective.');
  }

  // Check limits
  const { maxWebhooksPerUserPerCollective } = config.limits;
  const webhooksCount = await models.Notification.countRegisteredWebhooks(collective.id);
  if (webhooksCount >= maxWebhooksPerUserPerCollective) {
    throw MaxWebhooksExceededError;
  }

  // Create webhook
  const { webhookUrl, type } = args.notification;
  return models.Notification.create({
    UserId: remoteUser.id,
    CollectiveId: collective.id,
    channel: channels.WEBHOOK,
    type,
    webhookUrl,
  });
}

/**
 * Deletes a notification by ID.
 */
export async function deleteNotification(args, remoteUser) {
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in as admin to delete a notification.');
  }

  const notification = await models.Notification.findOne({ where: { id: args.id } });
  if (!notification) {
    throw new NotFound(`Notification with ID ${args.id} not found.`);
  } else if (!remoteUser.isAdmin(notification.CollectiveId)) {
    throw new Unauthorized('You need to be logged in as admin to delete this notification.');
  }

  await notification.destroy();
  return notification;
}
