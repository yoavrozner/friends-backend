'use strict';

const { Transaction } = require('pipe-transaction');

const DbMixin = require('../mixins/db.mixin');
const CreateRequest = require('../models/create/CreateRequest');
const { validations, schemas } = require('../validation');

/**
 * create service
 */
module.exports = {
  name: 'create',

  /**
   * Service settings
   */
  settings: {
    autoApproveRanks: {
      ראל: 1,
      אלף: 2,
      תאל: 3,
      אלם: 4,
      סאל: 5,
      רסן: 6,
    },
  },

  /**
   * Mixins
   */
  mixins: [DbMixin('createRequests')],

  /**
   * Service metadata
   */
  metadata: {},

  /**
   * Service dependencies
   */
  dependencies: [],

  /**
   * Actions
   */
  actions: {
    /**
     * Create request action.
     *
     * @returns
     */
    request: {
      rest: {
        method: 'POST',
        path: '/request',
      },
      body: CreateRequest,
      async handler(ctx) {
        console.log('ctx: ', ctx);
        ctx.body ?? (ctx.body = ctx.params);
        validations.isRequesterAndCreatorTheSame(
          ctx.meta.user.id,
          ctx.body.creator
        );
        ctx.body.creator = ctx.meta.user.id;

        const request = ctx.body;
        request.createdAt = new Date();
        try {
          await schemas.createGroup.validateAsync(ctx.body.group);

          ctx.body.group.owner = ctx.meta.user.email.split('@')[0];

          if (!ctx.body.group.members.includes(ctx.body.group.owner)) {
            ctx.body.group.members.push(ctx.body.group.owner);
          }

          if (
            !Object.keys(this.settings.autoApproveRanks).includes(
              ctx.meta.user.rank.replace('"', '')
            )
          ) {
            console.log('if');
            const { fullName } = await this.broker.call(
              'users.getByKartoffelId',
              { id: request.approver }
            );
            let isApproverValid, minimumRank;

            if (request.group.type === 'distribution') {
              console.log('if1');
              isApproverValid = !!(
                await this.broker.call('users.searchApproverDistribution', {
                  partialName: fullName,
                })
              ).length;
              minimumRank = 'רסן';
              console.log('if2');
            } else {
              console.log('if3');
              isApproverValid = !!(
                await this.broker.call('users.searchApproverSecurity', {
                  partialName: fullName,
                })
              ).length;
              minimumRank = 'סאל';
              console.log('if4');
            }

            if (!isApproverValid) {
              console.log('if5');
              throw new Error(
                `The approver is supposed to be in the user's hierarchy and ${minimumRank} and up`
              );
            }

            request.status = 'Pending';
            console.log('if6');
            const res = await this.adapter.insert(ctx.body);
            console.log('if7');
            this.logger.info(res);
            console.log('if');
            ctx.emit('mail.create', request);
            console.log('if8');
            return res;
          }
          const transaction = new Transaction({});
          transaction.appendArray([
            {
              id: 'insert',
              action: async () => {
                request.status = 'Approved';
                const newGroup = await this.adapter.insert(request);
                if (!newGroup) {
                  throw new Error(
                    `Failed to create the group ${JSON.stringify(ctx.body)}`
                  );
                }
                this.logger.info(newGroup);
                console.log('beforemail', newGroup);
                ctx.emit('mail.create', request);
                console.log('aftermail', newGroup);
                return newGroup;
              },

              undo: () => this.adapter.removeById(ctx.params.id),
            },
            {
              id: 'groupsCreate',
              action: async () => {
                const groupsCreate = await this.broker.call(
                  'ad.groupsCreate',
                  ctx.body.group
                );
                if (!groupsCreate.success) {
                  throw new Error(
                    `Failed to create a group: ${groupsCreate.message}`
                  );
                }
                return groupsCreate;
              },
            },
          ]);

          const transactionsResult = Promise.resolve(transaction.exec()).catch(
            (err) => {
              throw new Error(
                `Error: Transaction failed, one or more of the undo functions failed: ${JSON.stringify(
                  err.undoInfo.errorInfo.map((error) => error.id)
                )}`
              );
            }
          );

          const { isSuccess, actionsInfo } = await transactionsResult;

          if (isSuccess) {
            return actionsInfo.responses.groupsCreate;
          }
          throw new Error(actionsInfo.errorInfo.error.message);
        } catch (err) {
          console.log("errrrrrrr!!!!",err)
          ctx.meta.$statusCode =
            err.name === 'ValidationError' ? 400 : err.status || 500;
          return {
            name: err.name,
            message: err?.response?.message || err.message,
            success: false,
          };
        }
      },
    },

    /**
     * Approve request action.
     *
     * @returns
     */
    approve: {
      rest: {
        method: 'PUT',
        path: '/request/approve/:id',
      },
      async handler(ctx) {
        const transaction = new Transaction({});
        transaction.appendArray([
          {
            id: 'setApproved',
            action: async () => {
              const newGroup = await this.adapter.updateById(ctx.params.id, {
                $set: {
                  status: 'Approved',
                },
              });
              if (!newGroup) {
                throw new Error(
                  `Failed to update a group. Probably the id: '${ctx.params.id}' is wrong`
                );
              }
              return newGroup;
            },

            undo: () => {
              this.adapter.updateById(ctx.params.id, {
                $set: {
                  status: 'Pending',
                },
              });
            },
          },
          {
            id: 'groupsCreate',
            action: async (transactionsInfo) => {
              const newGroup =
                transactionsInfo.previousResponses['setApproved'];
              const { createdAt, ...newGroupWithOutCreatedAt } = newGroup;
              const groupsCreate = await this.broker.call(
                'ad.groupsCreate',
                newGroupWithOutCreatedAt.group
              );
              console.log('ad.groupsCreate res: ', JSON.stringify(groupsCreate));
              if (!groupsCreate) {
                throw new Error(
                  `Failed to create a group: ${groupsCreate.message}`
                );
              }
              return groupsCreate;
            },
          },
        ]);

        const transactionsResult = Promise.resolve(transaction.exec()).catch(
          (err) => {
            throw new Error(
              `Error: Transaction failed, one or more of the undo functions failed: ${JSON.stringify(
                err.undoInfo.errorInfo.map((error) => error.id)
              )}`
            );
          }
        );

        const { isSuccess, actionsInfo } = await transactionsResult;

        if (isSuccess) {
          return actionsInfo.responses.groupsCreate;
        }

        throw new Error(actionsInfo.errorInfo.error.message);
      },
    },

    /**
     * Deny request action.
     *
     * @returns
     */
    deny: {
      rest: {
        method: 'PUT',
        path: '/request/deny/:id',
      },
      async handler(ctx) {
        try {
          return await this.adapter.updateById(ctx.params.id, {
            $set: {
              status: 'Denied',
            },
          });
        } catch (err) {
          console.error(err);
          throw new Error('Failed to deny a request');
        }
      },
    },

    /**
     * Get requests by creator action.
     *
     * @returns
     */
    requestsByCreator: {
      rest: {
        method: 'GET',
        path: '/requests/creator',
      },
      async handler(ctx) {
        try {
          const res = await this.adapter.find({
            query: { creator: ctx.meta.user.id },
          });

          return { requests: res };
        } catch (err) {
          console.error(err);
          throw new Error("Failed to get creator's requests");
        }
      },
    },

    /**
     * Get requests by approver action.
     *
     * @returns
     */
    requestsByApprover: {
      rest: {
        method: 'GET',
        path: '/requests/approver',
      },
      async handler(ctx) {
        try {
          const res = await this.adapter.find({
            query: { approver: ctx.meta.user.id, status: 'Pending' },
          });

          return { requests: res };
        } catch (err) {
          console.error(err);
          throw new Error("Failed to get approver's requests");
        }
      },
    },
  },

  /**
   * Events
   */
  events: {},

  /**
   * Methods
   */
  methods: {},

  /**
   * Service created lifecycle event handler
   */
  created() {},

  /**
   * Service started lifecycle event handler
   */
  async started() {},

  /**
   * Service stopped lifecycle event handler
   */
  async stopped() {},

  /**
   * Fired after database connection establishing.
   */
  async afterConnected() {
    if (!!this.adapter.collection) {
      await this.adapter.collection.createIndex({ creator: 1, approver: 1 });
    }
  },
};
