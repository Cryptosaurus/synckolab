/* 
 ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1 
 * 
 * The contents of this file are subject to the Mozilla Public License Version 
 * 1.1 (the "License"); you may not use this file except in compliance with 
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 * 
 * Software distributed under the License is distributed on an "AS IS" basis, 
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License 
 * for the specific language governing rights and limitations under the 
 * License. 
 * 
 * Copyright (c) Niko Berger  2005-2012
 * Copyright (c) Kolab Systems 2012
 * Author: Niko Berger <berger(at)kolabsys.com>
 * Contributor(s): Steven D Miller (Copart) <stevendm(at)rellims.com>
 *					
 * 
 * Alternatively, the contents of this file may be used under the terms of 
 * either the GNU General Public License Version 2 or later (the "GPL"), or 
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"), 
 * in which case the provisions of the GPL or the LGPL are applicable instead 
 * of those above. If you wish to allow use of your version of this file only 
 * under the terms of either the GPL or the LGPL, and not to allow others to 
 * use your version of this file under the terms of the MPL, indicate your 
 * decision by deleting the provisions above and replace them with the notice 
 * and other provisions required by the GPL or the LGPL. If you do not delete 
 * the provisions above, a recipient may use your version of this file under 
 * the terms of any one of the MPL, the GPL or the LGPL. 
 * 
 * 
 ***** END LICENSE BLOCK ***** */
"use strict";

if(!synckolab) var synckolab={};

/*
 * A kinda "provider" class for syncing the address book.
 * The functions are called by the main synckolab loop to
 * create email content and called with email content (complete 
 * body) to generate add/update contacts in the address book.
 *  
 */
synckolab.AddressBook = {

	gConfig: null, // remember the configuration name
	gCurUID: '', // save the last checked uid - for external use

	gCards: '', // remember the current card list 
	gCardDB: '', // hashmap for all the cards (faster than iterating on big numbers)
	folderMessageUids: '',
	
	email: '', // holds the account email
	name: '', // holds the account name
	
	doc: '', // this is the owning document
	itemList: '', // display the currently processed item with status
	curItemInList: '', // the current item in the list (for updating the status)
	curItemInListId: '',
	curItemInListStatus: '',
	curItemInListContent: '',

	forceServerCopy: false,
	forceLocalCopy: false,
	
	processedIds: [],	// remember all processed ids to remove duplicates

	/**
	 * add the address book specific configuration to the config object.
	 * this is called every time the config is re-/read
	 * @param config the config object (name is already prefilled)
	 * @param pref a nsIPrefBranch for reading of the configuration 
	 */
	readConfig: function(config, pref) {
		synckolab.tools.logMessage("Reading Configuration:" + config.name, synckolab.global.LOG_DEBUG);

		// get the rdf for the Addresbook list
		// the addressbook type nsIAbDirectory
		
		var cn = synckolab.addressbookTools.getABDirectory(!config.syncListener?null:{
			getConfig: function(addressBokName) {
				// search through the configs  
				for(var j = 0; j < synckolab.main.syncConfigs.length; j++) {
					if(synckolab.main.syncConfigs[j] && synckolab.main.syncConfigs[j].type === "contact") {
						var curConfig = synckolab.main.syncConfigs[j];
						//synckolab.tools.logMessage("checking " + curConfig.contact.folderMsgURI + " vs. " + folder, synckolab.global.LOG_DEBUG);

						if(curConfig.enabled && curConfig.syncListener) {
							if(curConfig.source === addressBokName || synckolab.tools.text.fixNameToMiniCharset(curConfig.source) === synckolab.tools.text.fixNameToMiniCharset(addressBokName))
							{
								return curConfig;
							}
						}
					}
				}
			},
			finishMsgfolderChange: function(folder) {
				folder.updateFolder(msgWindow);
				folder.compact({
					OnStartRunningUrl: function ( url )
					{	
					},

					OnStopRunningUrl: function ( url, exitCode )
					{	
						synckolab.tools.logMessage("Finished trigger", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
						synckolab.global.triggerRunning = false;
					}
				}, msgWindow);
			},
			
			onItemAdded: function(parent, newCard) {
				if(!parent) {
					return;
				}
				// make sure not to parse messages while a full sync is running
				if(synckolab.global.running || synckolab.global.triggerRunning) {
					return;
				}

				var cConfig = this.getConfig(parent.dirName);
				if(!cConfig) {
					return;
				}
				
				// save the new card on the server
				newCard = newCard.QueryInterface(Components.interfaces.nsIAbCard);
				synckolab.tools.logMessage("trigger new card", synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
				
				// get the dbfile from the local disk
				var cUID = null;
				
				cUID = synckolab.addressbookTools.getUID(newCard);
				if (!cUID) {
					// generate a unique id (will random be enough for the future?)
					if (newCard.isMailList) {
						// marker for distribution lists
						cUID = "sk-dl-" + synckolab.tools.text.randomVcardId();
					} else {
						// vcards
						cUID = "sk-vc-" + synckolab.tools.text.randomVcardId();
					}

					synckolab.addressbookTools.setUID(newCard, cUID);
					// avoid loop
					synckolab.global.triggerRunning = true;
					this.tools.modifyTBEntry(cConfig, newCard);
					synckolab.global.triggerRunning = false;
				}
				
				// remember that we just worked with this one
				if(synckolab.config.checkIdProcessed(cConfig, cUID)) {
					synckolab.tools.logMessage("skipping add of "+cUID+" because it was recently processed", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					return;
				}

				if (newCard.isMailList) {
					synckolab.tools.logMessage("[addressbook.js] adding unsaved list: " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
				} else {
					synckolab.tools.logMessage("[addressbook.js] adding unsaved card: " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
				}
				
				// and write the message
				var abcontent = synckolab.addressbookTools.card2Message(newCard, cConfig.email, cConfig.format);
				synckolab.tools.logMessage("[addressbook.js] New Card " + abcontent, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

				// get the dbfile from the local disk
				var idxEntry = synckolab.tools.file.getSyncDbFile(cConfig, cUID);
				// write the current content in the sync-db file (parse to json object first)
				synckolab.tools.writeSyncDBFile(idxEntry, synckolab.addressbookTools.parseMessageContent(synckolab.tools.parseMail(abcontent)));

				synckolab.tools.logMessage("[addressbook.js] Writing card ("+cUID+") to imap " , synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

				synckolab.global.triggerRunning = true;

				var listener = this;

				// check if we have the message already in the folder - if so delete the old one
				synckolab.main.removeImapMessages(cUID, cConfig, function(){
					synckolab.main.writeImapMessage(abcontent, cConfig, 
					{
						OnProgress: function (progress, progressMax) {},
						OnStartCopy: function () { },
						SetMessageKey: function (key) {},
						OnStopCopy: function (status) { 
							// update folder information from imap and make sure we got everything
							synckolab.tools.logMessage("Finished writing contact entry to imap - compacting", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
							listener.finishMsgfolderChange(cConfig.folder);
						}
					});
				});
			},
			onItemRemoved: function(parent, item) {
				if(!parent) {
					return;
				}
				// make sure not to parse messages while a full sync is running
				if(synckolab.global.running || synckolab.global.triggerRunning) {
					return;
				}
				
				var cConfig = this.getConfig(parent.dirName);
				if(!cConfig) {
					return;
				}

				var cUID = synckolab.addressbookTools.getUID(item);
				// the item doesnt have an uuid - skip
				if(!cUID) {
					return;
				}

				// remember that we just worked with this one
				if(synckolab.config.checkIdProcessed(cConfig, cUID)) {
					synckolab.tools.logMessage("skipping because recently processed", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					return;
				}

				// find the correct message to the given uid
				if(cConfig.msgList.length() === 0) {
					synckolab.tools.fillMessageLookup(cConfig.msgList, config, synckolab.addressbookTools.parseMessageContent);
				}
				
				synckolab.global.triggerRunning = true;
				
				// get and delete the message
				var msg = cConfig.msgList.get(cUID);
				if(msg) {
					var list = null;
					// use mutablearray
					list = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
					synckolab.tools.logMessage("deleting [" + cUID + "]");
					list.appendElement(msg, false);	
					cConfig.folder.deleteMessages(list, msgWindow, true, false, null, true);
					
					// also remove sync db file
					var idxEntry = synckolab.tools.file.getSyncDbFile(cConfig, cUID);
					idxEntry.remove(false);
				}

				this.finishMsgfolderChange(cConfig.folder);
			},
			onItemPropertyChanged: function(item, prop, oldval, newval) {
				// make sure not to parse messages while a full sync is running
				if(synckolab.global.running || synckolab.global.triggerRunning) {
					return;
				}
				
				var dirName = item.directoryId.substring(item.directoryId.lastIndexOf("&")+1);
				
				// local change triggers a full sync
				synckolab.tools.logMessage("item changed in "+ dirName, synckolab.global.LOG_INFO);
				
				// get the right config for this address book
				var cConfig = this.getConfig(dirName);
				if(!cConfig) {
					return;
				}

				var cUID = synckolab.addressbookTools.getUID(item);
				// the item doesnt have an uuid - create one
				if(!cUID) {
					// generate a unique id (will random be enough for the future?)
					if (item.isMailList) {
						// marker for distribution lists
						cUID = "sk-dl-" + synckolab.tools.text.randomVcardId();
					} else {
						// vcards
						cUID = "sk-vc-" + synckolab.tools.text.randomVcardId();
					}
					synckolab.addressbookTools.setUID(item, cUID);
					this.tools.modifyTBEntry(this.gConfig, item);
					
					if (item.isMailList) {
						synckolab.tools.logMessage("adding unsaved list: " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					} else {
						synckolab.tools.logMessage("adding unsaved card: " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					}
					
					cUID = synckolab.addressbookTools.getUID(item);
				}
				
				// remember that we just worked with this one
				if(synckolab.config.checkIdProcessed(cConfig, cUID)) {
					synckolab.tools.logMessage("skipping because recently processed", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					return;
				}

				// and write the message
				var abcontent = synckolab.addressbookTools.card2Message(item, cConfig.email, cConfig.format);
				synckolab.tools.logMessage("Updated Card " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

				synckolab.tools.logMessage("looking for message", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

				// finally update imap
				// find the correct message to the given uid
				if(cConfig.msgList.length() === 0) {
					synckolab.tools.fillMessageLookup(cConfig.msgList, config, synckolab.addressbookTools.parseMessageContent);
				}

				synckolab.global.triggerRunning = true;

				// get the dbfile from the local disk
				var idxEntry = synckolab.tools.file.getSyncDbFile(cConfig, cUID);

				// get and delete the message
				var msg = cConfig.msgList.get(cUID);
				if(msg) {
					var list = null;
					// use mutablearray
					list = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
					synckolab.tools.logMessage("deleting [" + cUID + "]");
					list.appendElement(msg, false);	
					cConfig.folder.deleteMessages(list, msgWindow, true, false, null, true);
					idxEntry.remove(false);
				}
				
				// add new
				synckolab.tools.logMessage("Writing card to imap" , synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

				// remember that we just added this one
				cConfig.recentProcessed.push(cUID);

				// write the current content in the sync-db file (parse to json object first)
				synckolab.tools.writeSyncDBFile(idxEntry, synckolab.addressbookTools.parseMessageContent(synckolab.tools.parseMail(abcontent)));

				// remove potential duplicates, before writing the new message
				var listener = this;
				synckolab.main.removeImapMessages(cUID, cConfig, function(){
					synckolab.main.writeImapMessage(abcontent, cConfig, 
					{
						OnProgress: function (progress, progressMax) {},
						OnStartCopy: function () { },
						SetMessageKey: function (key) {},
						OnStopCopy: function (status) { 
							synckolab.tools.logMessage("Finished writing contact entry to imap", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
							listener.finishMsgfolderChange(cConfig.folder);
						}
					});
				});

			}
		});
		var ABook = cn.getNext();
		config.addressBook = null;
		while (ABook)
		{
			var cur = ABook.QueryInterface(Components.interfaces.nsIAbDirectory);
			if (cur.dirName === config.addressBookName ||
				synckolab.tools.text.fixNameToMiniCharset(config.source) === synckolab.tools.text.fixNameToMiniCharset(cur.dirName)
				)
			{
				config.addressBook = cur;
				break;
			}
			if (cn.hasMoreElements())
			{
				ABook = cn.getNext();
			}
			else
			{
				alert("Unable to find adress book.. please reconfigure!");
				return;
			}
		}
		
		// the current sync database filen (a file with uid:size:date:localfile)
		// uid -> filename database - main functions needs to know the name
		config.dbFile = synckolab.tools.file.getHashDataBaseFile(config);
		
		// the uid database for the distribution lists (name -> hash; hash -> name); read from the config
		config.listLookup = {
				// db file 
				dbFile: synckolab.tools.file.getSyncDbFile(config, "listUUID.database"),
				db: null,	// the database
				idToName: null,	// hashmap: uuid -> name
				nameToId: null,	// hashmap: name -> uuid
				
				/**
				 * read and initialize the hashmaps for lookup
				 */
				read: function() {
					// read the array as json: {[ {name: "string", uid: "string"} ,...]}
					this.db = synckolab.tools.readSyncDBFile(this.dbFile);
					// make sure we ALWAYS have an array
					if(!this.db) {
						this.db = [];
					}
					this.idToName = {};
					this.nameToId = {};
					for(var i = 0; i < this.db.length; i++) {
						var curListEntry = this.db[i];
						this.idToName[curListEntry.uuid] = curListEntry.name;
						this.nameToId[curListEntry.name] = curListEntry.uuid;
					}
				},
				
				/**
				 * write the list back to the file (or create if not existant)
				 */
				write: function() {
					synckolab.tools.writeSyncDBFile(this.dbFile, this.db);
				},
				
				/**
				 * get the UUID to a given name
				 * @return null if the uuid does not exist
				 */
				getUUID: function(name) {
					return this.nameToId[name];
				},
				
				/**
				 * get the name to a given UUID
				 * @return null if the name does not exist
				 */
				getName: function(uuid) {
					return this.idToName[uuid];
				},
				
				add: function (name, uuid) {
					var curListEntry = {
								name: name,
								uuid: uuid
							};
					this.db.push(curListEntry);
					this.idToName[curListEntry.uuid] = curListEntry.name;
					this.nameToId[curListEntry.name] = curListEntry.uuid;
					
					// write every time we have a new entry
					this.write();
				},

				// remove an entry, persist - rereading is not really necessary
				remove: function(uuid) {
					for(var i = 0; i < this.db.length; i++) {
						if(uuid === this.db[i].uuid) {
							// remove id
							this.db.splice(i, 1);
							break;
						}
					}
					// write to db
					this.write();
				}
		};
		
		// make sure its filled
		config.listLookup.read();
	},

	init: function (config, itemList, document) {
		// shortcuts for some common used utils
		this.tools = synckolab.addressbookTools;
		
		this.itemList = itemList;
		this.doc = document;

		this.forceServerCopy = false;
		this.forceLocalCopy = false;
		
		this.folderMessageUids = []; // the checked uids - for better sync
		
		// get the sync config
		this.gConfig = config;
		
		// clear the already processed ids
		this.processedIds = [];
		
		// clean out cardDb to avoid conflicts with autosync
		this.gConfig.cardDb = null;
		// clean out recently processed - we are in manual mode
		this.gConfig.recentProcessed = [];
		
		// a hashmap remembering all the cards - for faster use
		this.gCardDB = new synckolab.hashMap();

		// shouldnt happen, since we have a config...
		if(this.gConfig.type !== "contact") {
			synckolab.tools.logMessage("address book missing, please restart or try again", synckolab.global.LOG_ERROR + synckolab.global.LOG_AB);
			return null;
		}
		

		// cache all the cards with the uid in the CardDB hashmap
		// fill the hashmap
		var lCards = this.gConfig.addressBook.childCards;
		var card = null;
		// read all cards
		while (lCards.hasMoreElements() && (card = lCards.getNext()))
		{
			// get the right interface
			if(card.isMailList) {
				card = card.QueryInterface(Components.interfaces.nsIAbDirectory);
			} else {
				card = card.QueryInterface(Components.interfaces.nsIAbCard);
			}
			
			// create a UUID if it does not exist!
			var cUID = synckolab.addressbookTools.getTbirdUUID(card, this.gConfig);
			this.gCardDB.put(cUID, card);
		}
	},
	
	
	/**
	 * callback when a new message has arrived
	 */
	triggerParseAddMessage: function(message) {
		// make sure not to parse messages while a full sync is running
		if(synckolab.global.running || synckolab.global.triggerRunning) {
			return;
		}
		
		// parse the new message content
		var newCard = synckolab.addressbookTools.parseMessageContent(message.fileContent);
		
		// get the dbfile from the local disk
		var cUid = synckolab.addressbookTools.getUID(newCard);
		var idxEntry = synckolab.tools.file.getSyncDbFile(message.config, cUid);

		// check if the entry is in the address book
		var curCard = null;
		var cards = message.config.addressBook.childCards;
		while (cards.hasMoreElements())
		{
			var cCard = cards.getNext().QueryInterface(Components.interfaces.nsIAbCard);
			if(synckolab.addressbookTools.getUID(cCard) === cUid) {
				curCard = cCard;
				break;
			}
		}
		
		// if we have this card locally - remove
		if(curCard) {
			var deleteList = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
			deleteList.appendElement(curCard, false);
	
			try
			{
				message.config.addressBook.deleteCards(deleteList);
			}
			catch (e)
			{
				synckolab.tools.logMessage("unable to delete card: " + curCard.uid, synckolab.global.LOG_ERROR + synckolab.global.LOG_AB);
				return;
			}

		}
		
		// write the pojo into a file for faster comparison in later sync
		synckolab.tools.writeSyncDBFile(idxEntry, newCard);
		
		synckolab.tools.logMessage("card is new, add to address book: " + cUid, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
		// convert to a thunderbird object and add to the address book 
		if (newCard.type === "maillist")
		{
			// add mailing lists - add list of currently added cards
			if(!message.config.cardDb) {
				message.config.cardDb = new synckolab.hashMap();
				var lCards = message.config.addressBook.childCards;
				var card = null;
				// read all cards
				while (lCards.hasMoreElements() && (card = lCards.getNext()))
				{
					// get the right interface
					card = card.QueryInterface(Components.interfaces.nsIAbCard);
					
					// create a UUID if it does not exist!
					var cUID = synckolab.addressbookTools.getTbirdUUID(card, message.config);
					message.config.cardDb.put(cUID, card);
				}
			}
			// add the mailing list: this will also check each entry and link it - if not create it
			synckolab.addressbookTools.addMailingList(message.config.addressBook, newCard, message.config.cardDb);
			
			// also add to the hash-database
			//this.gCardDB.put(this.tools.getUID(newCard), newCard);
		}
		else
		{
			// also copy the image
			var pNameA = synckolab.addressbookTools.getCardProperty(newCard, "PhotoName");
			if (pNameA && pNameA !== "" && pNameA !== "null")
			{
				// in case the copy failed - clear the photoname
				if (synckolab.addressbookTools.copyImage(pNameA) === false) {
					synckolab.addressbookTools.setCardProperty(newCard, "PhotoName", "");
				}
			}
			
			message.config.addressBook.addCard(synckolab.addressbookTools.createTBirdObject(newCard));
			// clean out old cardDb
			message.config.cardDb = null;
		}


	},

	/**
	 * callback when a message has been deleted which should contain a contact
	 */
	triggerParseDeleteMessage: function(message) {
		// make sure not to parse messages while a full sync is running
		if(synckolab.global.running || synckolab.global.triggerRunning) {
			return;
		}
		
		// parse the new message content
		var newCard = synckolab.addressbookTools.parseMessageContent(message.fileContent);
		
		// find the entry in the address book and remove it
		var cId = synckolab.addressbookTools.getUID(newCard);
		var cards = message.config.addressBook.childCards;
		var deleteList = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
		while (cards.hasMoreElements())
		{
			var cCard = cards.getNext().QueryInterface(Components.interfaces.nsIAbCard);
			if(synckolab.addressbookTools.getUID(cCard) === cId) {
				synckolab.tools.logMessage("found card to delete: " + cId, synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
				deleteList.appendElement(cCard, false);
				break;
			}
		}
		
		try
		{
			message.config.addressBook.deleteCards(deleteList);
		}
		catch (e)
		{
			synckolab.tools.logMessage("unable to delete card: " + cId, synckolab.global.LOG_ERROR + synckolab.global.LOG_AB);
			return;
		}

		
		// get the dbfile from the local disk
		var idxEntry = synckolab.tools.file.getSyncDbFile(message.config, cId);
		if (idxEntry.exists()) {
			idxEntry.remove(true);
		}

		// also delete image
		var pNameA = synckolab.addressbookTools.getCardProperty(newCard, "PhotoName");
		if (pNameA && pNameA !== "" && pNameA !== "null")
		{
			// delete actual image
			var fileTo = synckolab.tools.getProfileFolder();
			fileTo.append("Photos");
			if (!fileTo.exists()) {
				fileTo.create(1, parseInt("0775", 8));
			}

			// fix newName: we can have C:\ - file:// and more - remove all that and put it in the photos folder
			var newName = pNameA.replace(/[^A-Za-z0-9._ \-]/g, "");
			newName = newName.replace(/ /g, "_");

			// check if the file exists
			fileTo.append(newName);
			if(fileTo.exists()){
				fileTo.remove(true);
			}
		}

		synckolab.tools.logMessage("deleting card: " + cId, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
		
	},

	/**
	 * a callback function for synckolab.js - synckolab will only start with the sync when this returns true
	 * for abook: data getting is synchronous so not needed - calendar is a different story!
	 */
	dataReady: function () {
		return true;
	},
	/**
	 * Returns the number of cards in the adress book
	 */
	itemCount: function () {
		var cards = this.gConfig.addressBook.childCards;
		
		var i = 0;
		while (cards.hasMoreElements() && cards.getNext())
		{
			i++;
		}
		
		return i;
	},
	
	/**
	 * parses the given content, if an update is required the 
	 * new message content is returned otherwise null
	 */	
	parseMessage: function (fileContent, tmp, checkForLater) {
		// mailing lists should be kept for "after" the normal messages have been parsed
		if (checkForLater)
		{
			if (this.tools.isMailList(fileContent.content))
			{
				return "LATER";
			}
		}
		// the new card might be a card OR a directory
		var newCard = null;
		var pName;	// temp for photos
		var abcontent;
		
		// create a new item in the itemList for display
		this.curItemInList = this.doc.createElement("treerow");
		this.curItemInListId = this.doc.createElement("treecell");
		this.curItemInListStatus = this.doc.createElement("treecell");
		this.curItemInListContent = this.doc.createElement("treecell");
		this.curItemInListId.setAttribute("label", synckolab.global.strBundle.getString("unknown"));
		this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("parsing"));
		this.curItemInListContent.setAttribute("label", synckolab.global.strBundle.getString("unknown"));
		
		this.curItemInList.appendChild(this.curItemInListId);
		this.curItemInList.appendChild(this.curItemInListStatus);
		this.curItemInList.appendChild(this.curItemInListContent);
		
		if (this.itemList)
		{
			var curListItem = this.doc.createElement("treeitem");
			curListItem.appendChild(this.curItemInList);
			this.itemList.appendChild(curListItem);
			synckolab.tools.scrollToBottom(this.itemList);
		}
				
		// parse the new item
		newCard = this.tools.parseMessageContent(fileContent);
		
		
		if (newCard && newCard.isMailList)
		{
			synckolab.tools.logMessage("got mailing list " + this.tools.getUID(newCard) +"\n " + newCard.toSource(), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
		}
		/*
		if (newCard && newCard.isMailList)
		{
			// skip mailing lists
			this.curItemInListContent.setAttribute("label", synckolab.global.strBundle.getString("mailingList") + " <" + newCard.DisplayName + ">");
			this.curItemInListId.setAttribute("label", synckolab.global.strBundle.getString("noChange"));
			synckolab.tools.logMessage("skipping mailing lists!", synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
			return null;
		}
		*/
		if (newCard) 
		{
			// remember current uid
			this.gCurUID = this.tools.getUID(newCard);
			
			// remember that we did this uid already
			this.folderMessageUids.push(this.gCurUID);
			synckolab.tools.logMessage("got card from message: " + this.gCurUID, synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);

			// update list item
			this.curItemInListId.setAttribute("label", this.gCurUID);
			this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("checking"));
			
			// since we disabled mailing list - wont come here
			if (newCard.type === "maillist") {
				this.curItemInListContent.setAttribute("label", synckolab.global.strBundle.getString("mailingList") + " <" + newCard.DisplayName + ">");
			} else if (this.tools.getCardProperty(newCard, "DisplayName") !== "") {
				this.curItemInListContent.setAttribute("label", this.tools.getCardProperty(newCard, "DisplayName") + 
						" <" + this.tools.getCardProperty(newCard, "PrimaryEmail","---") + ">");
			} else {
				this.curItemInListContent.setAttribute("label", this.tools.getCardProperty(newCard, "FirstName") + " " + 
						this.tools.getCardProperty(newCard, "LastName") + 
						" <" + this.tools.getCardProperty(newCard, "PrimaryEmail","---") + ">");
			}

			// check if we have this id already
			var pi;
			for(pi = 0; pi < this.processedIds.length; pi++) {
				if(this.processedIds[pi] === this.tools.getUID(newCard)) {
					synckolab.tools.logMessage("removing duplicate " + this.tools.getUID(newCard), synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
					this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("deleteOnServer"));
					return "DELETEME";
				}
			}
			// add the id to the list of processed ids
			this.processedIds.push(this.tools.getUID(newCard));
			
			// ok lets see if we have this one already
			var foundCard = this.gCardDB.get(this.gCurUID);


			// get the dbfile from the local disk
			var idxEntry = synckolab.tools.file.getSyncDbFile(this.gConfig, this.tools.getUID(newCard));
			// convert card to pojo for easier internal work
			if(foundCard) {
				foundCard = synckolab.addressbookTools.card2Pojo(foundCard, this.gCurUID);
				synckolab.tools.logMessage("got entry from db: " + foundCard.toSource(), synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);	
			} else {
				synckolab.tools.logMessage("unable to find card in DB: " + this.gCurUID, synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);	
			}

			// a new card or locally deleted 
			if (foundCard === null)
			{	
				// if the file does not exist and it is not found in the adress book -
				// we definitely have a new entry here - add it 
				// also do so if the forceLocalCopy flag is set (happens when you change the configuration)
				if (!idxEntry.exists() || this.forceLocalCopy)
				{
					// write the pojo into a file for faster comparison in later sync
					synckolab.tools.writeSyncDBFile(idxEntry, newCard);
					
					// convert to a thunderbird object and add to the address book 
					if (newCard.type === "maillist")
					{
						synckolab.tools.logMessage("list is new, add to address book: " + this.tools.getUID(newCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);

						// add the mailing list: this will also check each entry and link it - if not create it
						synckolab.addressbookTools.addMailingList(this.gConfig.addressBook, newCard, this.gCardDB);
						
						// also add to the hash-database
						this.gCardDB.put(this.tools.getUID(newCard), newCard);
					}
					else
					{
						synckolab.tools.logMessage("card is new, add to address book: " + this.tools.getUID(newCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
						// also copy the image
						var pNameA = this.tools.getCardProperty(newCard, "PhotoName");
						if (pNameA && pNameA !== "" && pNameA !== "null")
						{
							// in case the copy failed - clear the photoname
							if (this.tools.copyImage(pNameA) === false) {
								this.tools.setCardProperty(newCard, "PhotoName", "");
							}
						}
						
						var abCard = synckolab.addressbookTools.createTBirdObject(newCard);
						this.gConfig.addressBook.addCard(abCard);
						// also add to the hash-database
						this.gCardDB.put(this.tools.getUID(newCard), abCard);
					}
					
					//update list item
					this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("localAdd"));
					// new card added - we are done
					return null;
				}
				else
				{
					synckolab.tools.logMessage("card deleted locally: " + this.tools.getUID(newCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);	
					
					//update list item
					this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("deleteOnServer"));
	
					try
					{
						// also remove the local db file since we deleted the contact
						idxEntry.remove(false);
					}
					catch (deleidxEntry)
					{ // ignore this - if the file does not exist
					}
					
					// make sure to delete the message
					return "DELETEME";
				}
			}
			else
			// this card is already in the address book
			{
				// read the current card from the sync db (might be null)
				var cCard = synckolab.tools.readSyncDBFile(idxEntry);
				
				var cCard_equals_foundCard = false, cCard_equals_newCard = false, foundCard_equals_newCard = false;
				
				// Streamline card comparisons
				if (cCard && this.tools.equalsContact(cCard, foundCard)) {
					cCard_equals_foundCard = true;
					synckolab.tools.logMessage("In parse Message in addressbook.js cCard equals foundCard", synckolab.global.LOG_DEBUG);
				} else {
					cCard_equals_foundCard = false;
					synckolab.tools.logMessage("In parse Message in addressbook.js cCard NOT EQUALS foundCard\n ", synckolab.global.LOG_DEBUG);
				}
				
				if (cCard && this.tools.equalsContact(cCard, newCard)) {
					cCard_equals_newCard = true;
					synckolab.tools.logMessage("In parse Message in addressbook.js cCard equals newCard", synckolab.global.LOG_DEBUG);
				} else {
					cCard_equals_newCard = false;
					synckolab.tools.logMessage("In parse Message in addressbook.js cCard DOES NOT equal newCard", synckolab.global.LOG_DEBUG);
				}

				if (this.tools.equalsContact(foundCard, newCard)) {
					foundCard_equals_newCard = true;
					synckolab.tools.logMessage("In parse Message in addressbook.js foundCard equals newCard", synckolab.global.LOG_DEBUG);
				} else {
					foundCard_equals_newCard = false;
					synckolab.tools.logMessage("In parse Message in addressbook.js foundCard DOES NOT equal newCard", synckolab.global.LOG_DEBUG);
				}
				
				// compare each card with each other
				if ((idxEntry.exists() && !cCard_equals_foundCard && !cCard_equals_newCard) || (!idxEntry.exists() && !foundCard_equals_newCard))
				{
					//local and server were both updated, ut oh, what do we want to do?
					synckolab.tools.logMessage("Conflicts detected, testing for autoresolve.", synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
					
					//	This function returns an array on conflicting fields
					var conflicts = synckolab.addressbookTools.contactConflictTest(newCard, foundCard);
					var bUpdateLocal = false;
					var bUpdateServer = false;

					//If there were no conflicts found, skip dialog and update the local copy (Changes to the way the SHA are calculated could cause this)
					if (conflicts.length > 0) {
						synckolab.tools.logMessage("Conflicts length is greater than 0.", synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
						
						//Holds the users response, must be an object so that we can pass by reference
						var conflictResolution = {};
						conflictResolution.result = 0;

						//Open the contact conflict dialog
						switch (this.gConfig.defaultResolve) {
						case 'server':
							conflictResolution.result = 1;
							break;

						case 'client':
							conflictResolution.result = 2;
							break;

						default:
							conflictResolution.result = 0;
							var conflictDlg = window.openDialog("chrome://synckolab/content/contactConflictDialog.xul",
									"conflictDlg",
									"chrome,modal,resizable=1,width=600,height=400",
									conflicts,
									conflictResolution,
									newCard, foundCard);
							break;
						}
						 
						
						switch (conflictResolution.result) {
						case 0 :
							//User clicked Cancel or X, we move to next record and user can deal with this issue on next sync
							this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("conflict") + ": skipped");
							break;
						case 1 :
							//User chose to keep all server values
							bUpdateLocal = true;
							this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("conflict") + ": " + synckolab.global.strBundle.getString("localUpdate"));
							break;
						case 2 :
							//User chose to keep all local values
							bUpdateServer = true;
							this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("conflict") + ": " + synckolab.global.strBundle.getString("updateOnServer"));
							break;
						case 3 :
							//User chose a mix of values, therefore, both local and server need updating

							//newCard and foundCard both already contain the new values
							bUpdateLocal = true;
							bUpdateServer = true;
							this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("conflict") + ": both updated");
							break;
						}
					
					} else {
						//cards values are different, however, no apparent differences
						//Changes to the way the SHA (code revisions) are calculated could cause this
						synckolab.tools.logMessage("Contacts differ, however, assumed no change, update local" + this.tools.getUID(newCard), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
						bUpdateLocal = true;
						this.curItemInListStatus.setAttribute("label", "Auto Conflict Resolved : " + synckolab.global.strBundle.getString("localUpdate"));
					}
					
					if (bUpdateLocal) {
						// Update local entry
						var ulDelList = null;
						// first delete the card 
						ulDelList = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
						ulDelList.appendElement(foundCard, false);

						// server changed - update local
						if (foundCard.isMailList)
						{
							
							try
							{
								this.gConfig.addressBook.deleteDirectory(foundCard);
								// add the mailing list: this will also check each entry and link it - if not create it
								synckolab.addressbookTools.addMailingList(this.gConfig.addressBook, newCard, this.gCardDB);
								
								// also add to the hash-database
								this.gCardDB.put(this.tools.getUID(newCard), newCard);
							} catch (delMailList)
							{
								synckolab.tools.logMessage("problem with local update for - skipping" + this.tools.getUID(foundCard), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
							}
						}
						else
						{
							try
							{
								this.gConfig.addressBook.deleteCards(ulDelList);
	
								// also copy the image
								pName = this.tools.getCardProperty(newCard, "PhotoName");
								if (pName && pName !== "" && pName !== "null")
								{
									// in case the copy failed - clear the photoname
									if (this.tools.copyImage(pName) === false) {
										this.tools.setCardProperty(newCard, "PhotoName", "");
									}
								}
								
								// add the new one
								this.gConfig.addressBook.addCard(synckolab.addressbookTools.createTBirdObject(newCard));
							}
							catch (de)
							{
								synckolab.tools.logMessage("problem with local update for - skipping" + this.tools.getUID(foundCard), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
							}
						}	
						// write the current content in the sync-db file
						synckolab.tools.writeSyncDBFile(idxEntry, newCard);
					}

					if (bUpdateServer) {
						// update on server
						abcontent = this.tools.card2Message(foundCard, this.gConfig.email, this.gConfig.format);

						// write the current content in the sync-db file
						synckolab.tools.writeSyncDBFile(idxEntry, this.tools.parseMessageContent(synckolab.tools.parseMail(abcontent)));
						return abcontent;
					}
					return null; // Return null, we either updated nothing or updated only local
				}
				else
				// we got that already, see which to update (server change if db == local != server) - or actually no change
				if (!idxEntry.exists() || (cCard_equals_foundCard && !cCard_equals_newCard))
				{
					if (!idxEntry.exists()) {
						synckolab.tools.logMessage("In parse Message in addressbook.js idxEntry does not exist", synckolab.global.LOG_DEBUG);
					}
					
					if(foundCard_equals_newCard){
						synckolab.tools.logMessage("no change, but sync file missing: " + this.tools.getUID(foundCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					} else {
						synckolab.tools.logMessage("server changed: " + this.tools.getUID(foundCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					}
					
					// server changed - update local
					if (foundCard.isMailList)
					{
						
						try
						{
							this.gConfig.addressBook.deleteDirectory(foundCard);
							// add the mailing list: this will also check each entry and link it - if not create it
							synckolab.addressbookTools.addMailingList(this.gConfig.addressBook, newCard, this.gCardDB);
							
							// also add to the hash-database
							this.gCardDB.put(this.tools.getUID(newCard), newCard);
						} catch (delMailList2)
						{
							synckolab.tools.logMessage("problem with local update for - skipping" + this.tools.getUID(foundCard), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
						}
					}
					else
					{
						var list = null;
						list = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
						list.appendElement(foundCard, false);
						
						try
						{
							this.gConfig.addressBook.deleteCards(list);

							// also copy the image
							pName = this.tools.getCardProperty(newCard, "PhotoName");
							if (pName && pName !== "" && pName !== "null")
							{
								// in case the copy failed - clear the photoname
								if (this.tools.copyImage(pName) === false) {
									this.tools.setCardProperty(newCard, "PhotoName", "");
								}
							}

							this.gConfig.addressBook.addCard(synckolab.addressbookTools.createTBirdObject(newCard));
						}
						catch (delocalUpdate)
						{
							synckolab.tools.logMessage("problem with local update for - skipping" + this.tools.getUID(foundCard), synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
						}
						
					}

					synckolab.tools.logMessage("write sync db " + this.tools.getUID(foundCard), synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					
					// write the current content in the sync-db file
					synckolab.tools.writeSyncDBFile(idxEntry, newCard);

					// update list item
					if(foundCard_equals_newCard){
						this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("noChange"));
					}
					else {
						this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("localUpdate"));
					}
					return null;
				}
				else
				// is the db file equals server, but not local.. we got a local change
				if (idxEntry.exists() && !cCard_equals_foundCard && cCard_equals_newCard)
				{
					synckolab.tools.logMessage("client changed " + this.tools.getUID(foundCard) + " - " + cCard.primaryEmail, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
					
					// update list item
					this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("updateOnServer"));
					
					// remember this message for update - generate mail message (incl. extra fields)
					abcontent = this.tools.card2Message(foundCard, this.gConfig.email, this.gConfig.format);
					// write the current content in the sync-db file
					synckolab.tools.writeSyncDBFile(idxEntry, this.tools.parseMessageContent(synckolab.tools.parseMail(abcontent)));
					return abcontent;
				}
				
				this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("noChange"));
				
			}
		}
		else
		{
			this.curItemInListId.setAttribute("label", synckolab.global.strBundle.getString("unparseable"));
			synckolab.tools.logMessage("unable to parse message, skipping", synckolab.global.LOG_WARNING + synckolab.global.LOG_AB);
		}
			
		return null;
	},
	
	deleteList: "",

	initUpdate: function () {
		this.gCards = this.gConfig.addressBook.childCards;
		this.deleteList = Components.classes["@mozilla.org/array;1"].createInstance(Components.interfaces.nsIMutableArray);
		return true;
	},
	
	/**
	 * read the next card and return the content if we need an update
	 */
	nextUpdate: function () {
		var cur;
		// if there happens an exception, we are done
		if (!this.gCards.hasMoreElements())
		{
			// we are done
			synckolab.tools.logMessage("Finished syncing adress book", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
			return "done";
		}
		
		try
		{
			cur = this.gCards.getNext().QueryInterface(Components.interfaces.nsIAbCard);
		}
		catch (ext)
		{
			// we are done
			synckolab.tools.logMessage("Bad - Finished syncing adress book", synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
			return "done";
		}
		
		var abcontent = null;
		var idxEntry = null;
		var curItem = cur;
		
		// mailing lists are nsIABDirectory
		if (cur.isMailList)
		{
			synckolab.tools.logMessage("Convert Mailing list to nsIABDirectory", synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
			curItem = Components.classes["@mozilla.org/abmanager;1"].getService(Components.interfaces.nsIAbManager).getDirectory(cur.mailListURI);
		}
		
		var curListItem;
		
		// get the UUID and create on eif it does not exist yet
		var cUID = synckolab.addressbookTools.getTbirdUUID(curItem, this.gConfig);
		
		var alreadyProcessed = false;
		
		// check if we have this uid in the messages
		for (var i = 0; i < this.folderMessageUids.length; i++)
		{
			if (cUID === this.folderMessageUids[i])
			{
				synckolab.tools.logMessage("we got this contact already: " + cUID, synckolab.global.LOG_DEBUG + synckolab.global.LOG_AB);
				return null;
			}
		}

		// check the local database file
		idxEntry = synckolab.tools.file.getSyncDbFile(this.gConfig, cUID);
		
		if(!idxEntry) {
			alert("unable to get sync db file for " + cUID + " please check the access rights in your profile folder!");
			return;
		}
		
		// we got an idxEntry file... this means we do not have it on the imap server any more - delete it
		if (idxEntry && idxEntry.exists() && !this.forceServerCopy)
		{
			
			if (!curItem.isMailList)
			{
				this.deleteList.appendElement(curItem, false);
			} else {
				// delete list
				this.gConfig.addressBook.deleteDirectory(curItem);
			}
					
			// create a new item in the itemList for display
			this.curItemInList = this.doc.createElement("treerow");
			this.curItemInListId = this.doc.createElement("treecell");
			this.curItemInListStatus = this.doc.createElement("treecell");
			this.curItemInListContent = this.doc.createElement("treecell");
			this.curItemInListId.setAttribute("label", cUID);
			this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("localDelete"));
			if (curItem.isMailList) {
				this.curItemInListContent.setAttribute("label", synckolab.global.strBundle.getString("mailingList") + " <" + curItem.DisplayName + ">");
			} else {
				this.curItemInListContent.setAttribute("label", curItem.firstName + " " + curItem.lastName + " <" + curItem.primaryEmail + ">");
			}
			
			this.curItemInList.appendChild(this.curItemInListId);
			this.curItemInList.appendChild(this.curItemInListStatus);
			this.curItemInList.appendChild(this.curItemInListContent);
			
			if (this.itemList)
			{
				curListItem = this.doc.createElement("treeitem");
				curListItem.appendChild(this.curItemInList);
				this.itemList.appendChild(curListItem);
				synckolab.tools.scrollToBottom(this.itemList);
			}

			// also remove the local db file since we deleted the contact on the server
			idxEntry.remove(false);
			return null;
		}
		
		// ok its NOT in our internal db... this means its new - so add it to imap
		// create a new item in the itemList for display
		this.curItemInList = this.doc.createElement("treerow");
		this.curItemInListId = this.doc.createElement("treecell");
		this.curItemInListStatus = this.doc.createElement("treecell");
		this.curItemInListContent = this.doc.createElement("treecell");
		this.curItemInListId.setAttribute("label", cUID);
		this.curItemInListStatus.setAttribute("label", synckolab.global.strBundle.getString("addToServer"));
		if (curItem.isMailList) {
			this.curItemInListContent.setAttribute("label", synckolab.global.strBundle.getString("mailingList") + " <" + curItem.DisplayName + ">");
		} else {
			this.curItemInListContent.setAttribute("label", curItem.firstName + " " + curItem.lastName + " <" + curItem.primaryEmail + ">");
		}
		
		this.curItemInList.appendChild(this.curItemInListId);
		this.curItemInList.appendChild(this.curItemInListStatus);
		this.curItemInList.appendChild(this.curItemInListContent);
		
		if (this.itemList)
		{
			curListItem = this.doc.createElement("treeitem");
			curListItem.appendChild(this.curItemInList);
			this.itemList.appendChild(curListItem);
			synckolab.tools.scrollToBottom(this.itemList);
		}
			
		// convert to a pojo
		var curCard = synckolab.addressbookTools.card2Pojo(curItem, cUID);
		
		// and write the message
		abcontent = synckolab.addressbookTools.card2Message(curCard, this.gConfig.email, this.gConfig.format);
		synckolab.tools.logMessage("New Card " + cUID, synckolab.global.LOG_INFO + synckolab.global.LOG_AB);
			
		// get the dbfile from the local disk
		idxEntry = synckolab.tools.file.getSyncDbFile(this.gConfig, cUID);
		
		// write the current content in the sync-db file
		synckolab.tools.writeSyncDBFile(idxEntry, curCard);
	
		// return the cards content
		return abcontent;
	},
	
	doneParsing: function ()
	{
		try
		{
			this.gConfig.addressBook.deleteCards(this.deleteList);
		}
		catch (e)
		{
			// ignore
		}
	}
};
