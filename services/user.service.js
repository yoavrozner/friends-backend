"use strict";

const { default: axios } = require('axios');
const NodeCache = require('node-cache');
require('dotenv').config();

const kartoffelCaching = new NodeCache();

/**
 * @typedef {import('moleculer').Context} Context Moleculer's Context
 */

module.exports = {
	name: "users",

	/**
	 * Settings
	 */
	settings: {
		kartoffel: {
			proxyUrl: process.env.OUTGOING_PROXY_URL || "http://outgoing-proxy-service:8010/kartoffel",
			searchBase: "/api/persons/search?domainusers.datasource=nonExternals",

			domainUserBase: "/api/persons/domainuser",
			personBase: "/api/persons/",
			cacheTTL: process.env.CACHE_TTL || 7200000,
		},
		approvedRanks: [],
		defaultApproverIds: [],
		sortingRanks: {
			"ראל": 1,
			"אלף": 2,
			"תאל": 3,
			"אלם": 4,
			"סאל": 5,
			"רסן": 6,
			"rookie": 7,
		},
		hierarchyFilter: process.env.HIERARCHY_FILTER !== "false",
	},

	/**
	 * Dependencies
	 */
	dependencies: [],

	/**
	 * Actions
	 */
	actions: {

		/**
		 * Requests the AD service to search a user
		 * @param {String} partialName - partial name of the user
		 */
		searchUsers: {
            rest: {
				method: "GET",
				path: "/",
			},
			params: {
				partialName: "string"
			},
			async handler(ctx) {
				return await this.broker.call('ad.users', { partialName: ctx.params.partialName });
			},
        },

		/**
		 * Requests the Kartoffel to get person by his id
		 * @param {String} kartoffelId
		 */
		getByKartoffelId: {
			rest: {
				method: "GET",
				path: "/kartoffel/:id",
			},
		   async handler(ctx) {
			const res = await axios.get(
				`${this.settings.kartoffel.proxyUrl}${this.settings.kartoffel.personBase}/${ctx.params.id}`);
			return res.data;
		   },
        },

		/**
		 * Requests the Kartoffel to get person by his domain user id
		 * @param {String} domainuser - a unique domain user id
		 */
		getPersonByDomainUser: {
			rest: {
				method: "GET",
				path: "/domainuser/:domainuser",
			},
			async handler(ctx) {
				const res = await axios.get(
					`${this.settings.kartoffel.proxyUrl}${this.settings.kartoffel.domainUserBase}/${ctx.params.domainuser}`);
				return res.data;
			},
        },

		isSuper: {
			rest: {
				method: "GET",
				path: "/super",
			},
			async handler(ctx) {
				return this.settings.defaultApproverIds.includes(ctx.meta.user.id);
			}
		},

		/**
		 * Requests the Kartoffel to search a user
		 * @param {String} partialName - partial name of the approver
		 */
		 searchApproverSecurity: {
			rest: {
				method: "GET",
				path: "/approvers/security",
			},
			params: {
				partialName: "string",
			},
			async handler(ctx) {
				this.searchApprover({...ctx, isSecurity: true});
			},
        },

		/**
		 * Requests the Kartoffel to search a user
		 * @param {String} partialName - partial name of the approver
		 */
		 searchApproverDistribution: {
			rest: {
				method: "GET",
				path: "/approvers/distribution",
			},
			params: {
				partialName: "string",
			},
			async handler(ctx) {
				this.searchApprover({...ctx, isSecurity: false});
			},
        },
			
		/**
		 * @params user - the authenticated user
		 * @returns whether the user is an approver
		 */
        isApprover: {
			rest: {
				method: "GET",
				path: "/approver",
			},
			async handler(ctx) {
				if (process.env.AUTO_APPROVE === "true") return true;
				const user = ctx.meta.user;
				if (user?.rank) {
					return this.settings.approvedRanks.includes(user.rank);
				}
				return false;
			},
        },
	},

	/**
	 * Events
	 */
	events: {

	},

	/**
	 * Methods
	 */
	methods: {
		buildSearchApproverUrl(partialName) {
			let url = `${this.settings.kartoffel.proxyUrl}${this.settings.kartoffel.searchBase}`
			for (let rank of this.settings.approvedRanks) {
				url += `&rank=${rank}`;
			}
			return url;
		},

		async searchApprover(ctx) {
			try {
				const { params, meta, isSecurity } = ctx;
				// console.time("searchApprover");
				let hierarchyFilter;
				if (this.settings.hierarchyFilter) {
					const userHierarchy = meta.user.hierarchy;
					hierarchyFilter = userHierarchy.slice(0, userHierarchy.length <= 3 ? userHierarchy.length : 3);
				} else {
					hierarchyFilter = [];
				}
				const users = await this.kartoffelSearchHandler(params.partialName, hierarchyFilter, isSecurity);
				this.logger.info(users);
				// console.timeEnd("searchApprover");
				return users || [];
			} catch (err) {
				ctx.meta.$statusCode = err.name === 'ValidationError' ? 400 : err.status || 500;
				return { name: err.name, message: err?.response?.message || err.message, success: false };
			}
		},

		loadApprovedRanks() {
			// TODO: Enter all approved ranks (maybe do that from local file configured in env)
			if (!process.env.PRODUCTION) {
				this.settings.approvedRanks = [
					"mega",
					"rookie"
				];
			}
			const approvedRanks = [ "רסן", "סאל", "אלם", "תאל", "אלף", "ראל"];
			this.settings.approvedRanks = this.settings.approvedRanks.concat(approvedRanks);
		},

		async cacheApprovers() {
			await this.loadDefaultApprovers();
			setInterval(async () => {
				await this.loadDefaultApprovers();
			}, this.settings.kartoffel.cacheTTL);
		},

		async loadDefaultApprovers() {
			const responses = await Promise.allSettled(this.settings.defaultApproverIds.map(async (kartoffelId) => {
				return (await axios.get(`${this.settings.kartoffel.proxyUrl}${this.settings.kartoffel.searchBase}${kartoffelId}`))?.data
			}));
			let foundedUsers = [];

			responses.map((currentResponse) => {
				if (currentResponse.status === 'fulfilled') {
					foundedUsers.push(currentResponse.value);
				}
			});

			kartoffelCaching.set("defaultApprovers", foundedUsers);
		},

		// NOTICE: Currently only for get requests
		async kartoffelSearchHandler(partialName, hierarchyArray, isSecurity) {
			try {
				console.log("kartoffelSearchHandler");
				const approveStartIndex = isSecurity ? this.settings.approvedRanks.length - this.settings.sortingRanks["סאל"] : 0;
				const responses = await Promise.allSettled(
					this.settings.approvedRanks.slice(approveStartIndex).map(async(rank) => {
						return (await axios.get(`${this.settings.kartoffel.proxyUrl}${this.settings.kartoffel.searchBase}`, { params: {
							fullName: partialName,
							rank,
							status: "active"
						}}))?.data;
					})
				);

				let foundUsers = [];
				
				responses.map((currentResponse) => {
					if (currentResponse.status === 'fulfilled') {
						for (const currUser of currentResponse.value) {
							if (hierarchyArray.every((value, index) => currUser.hierarchy[index] === value)) {
								foundUsers.push(currentResponse.value);
							  }
						}
					}
				});

				foundUsers = foundUsers.sort((firstValue, secondValue) => this.settings.sortingRanks[firstValue.rank] >= this.settings.sortingRanks[secondValue.rank]);
				
				const defaultUsers = kartoffelCaching.get("defaultApprovers") || [];

				return [...defaultUsers, ...foundUsers];
			} catch (err) {
				this.logger.info(err);
				if (err.response && err.response.status) {
				  const statusCode = err.response.status;
				  if (statusCode === 404) {
					return null;
				  }
				}
				throw err;
			}
		},
	},


	/**
	 * Service created lifecycle event handler
	 */
	created() {
		
	},

	/**
	 * Service started lifecycle event handler
	 */
	async started() {
		this.loadApprovedRanks();
		this.cacheApprovers();
	},

	/**
	 * Service stopped lifecycle event handler
	 */
	async stopped() {

	}
};
