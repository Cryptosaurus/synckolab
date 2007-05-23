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
 * Contributor(s): Niko Berger <niko.berger@corinis.com>
 *                 Andreas Gungl <a.gungl@gmx.de>
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

/*
 * A kinda "provider" class for syncing the calendar. 
 * The functions are called by the main synckolab loop to 
 * create email content and called with email content (complete 
 * body) to generate add/update contacts in the calendar. 
 * 
 * This WILL be replaced and put into a real calendar provider
 * (As described by the Mozilla Calendar project)
 */

var syncCalendar = {
	folderPath: '', // String - the path for the entries
	serverKey: '', // the incoming server
	gSaveImap: true, // write back to folder
	gSync: true, // sync this configuration	
	gConfig: '', // remember the configuration name
	gCurUID: '', // save the last checked uid - for external use

	gToDo: '',
	gCurTodo: 0,
	gCurEvent: 0,
	folder: '', // the contact folder type nsIMsgFolder
	folderMsgURI: '', // the message uri
	gCalendarName: '', // the calendar name
	gCalendar: '', // the calendar
	gCalendarEvents: '', // all events from the calendar
	format: 'iCal', // the format iCal/Xml	
	folderMessageUids: '',
	
	email: '', // holds the account email
	name: '', // holds the account name

	dbFile: '', // the current sync database file
	db: '', // the current sync database

	itemList: '', // display the currently processed item with status
	curItemInList: '', // the current item in the list (for updating the status)
	curItemInListId: '',
	curItemInListStatus: '',
	curItemInListContent: '',

	forceServerCopy: false,
	forceLocalCopy: false,
	isCal: function() {
		return true
	},

	init: function(config) {
		if (!isCalendarAvailable ())
			return;
			
		this.forceServerCopy = false;
		this.forceLocalCopy = false;
			
		// initialize the configuration
		try {
			var pref = Components.classes["@mozilla.org/preferences-service;1"].getService(Components.interfaces.nsIPrefBranch);
			this.folderPath = pref.getCharPref("SyncKolab."+config+".CalendarFolderPath");
			this.serverKey = pref.getCharPref("SyncKolab."+config+".IncomingServer");
			this.gCalendarName = pref.getCharPref("SyncKolab."+config+".Calendar");
			this.format = pref.getCharPref("SyncKolab."+config+".CalendarFormat");			
			this.gSaveImap = pref.getBoolPref("SyncKolab."+config+".saveToCalendarImap");
			this.gSync = pref.getBoolPref("SyncKolab."+config+".syncCalendar");
			
		} catch(e) {
			return;
		}

		// get the correct calendar instance
		var calendars = getCalendars();
		for( var i = 0; i < calendars.length; i++ )
	    {
	    	if (calendars[i].name == this.gCalendarName)
	    	{
	    		this.gCalendar = calendars[i];
	    		break;
	    	}
		}		
		
		
    	this.folderMessageUids = new Array(); // the checked uids - for better sync
    	
    	// get the sync db
		this.dbFile = getHashDataBaseFile (config + ".cal");
		this.db = readDataBase (this.dbFile);
		this.gConfig = config;
	},
	
	init2: function (nextFunc, sync)	{
		// get ALL the items from calendar - when done call nextfunc
		this.gEvents.nextFunc = nextFunc;
		this.gEvents.events = new Array();
		this.gEvents.sync = sync;
		
		// gCalendar might be invalid if no calendar is selected in the settings
		if (this.gCalendar) {
		  this.gCalendar.getItems(this.gCalendar.ITEM_FILTER_TYPE_EVENT, 0, null, null, this.gEvents);
          // if no item has been read, onGetResult has never been called 
          // leaving us stuck in the events chain
		  if (this.gEvents.events.length > 0)
		      return true;
		  else
		      return false;
		}
		else {
		  alert("Please select a calender as sync target before trying to synchronize.");
		  return false;
		}
	},
	
	gEvents: {
		nextFunc: '',
		events: new Array(),
		sync: '',
		onOperationComplete: function(aCalendar, aStatus, aOperator, aId, aDetail) {		
			    logMessage("operation: status="+aStatus + " Op=" + aOperator + " Detail=" + aDetail, LOG_DEBUG + LOG_CAL);
			},
		onGetResult: function(aCalendar, aStatus, aItemType, aDetail, aCount, aItems) {
                logMessage("got results: " + aCount + " items", LOG_DEBUG + LOG_CAL);
                for (var i = 0; i < aCount; i++) {
                    this.events.push(aItems[i]);
                }
            }
	},

	/**
	 * Returns the number of cards in the adress book
	 */
	itemCount: function() {
		return this.gEvents.events.length;
	},
	
	/**
	 * parses the given content, if an update is required the 
	 * new message content is returned otherwise null
	 */	
	parseMessage: function(fileContent) {
		
		// create a new item in the itemList for display
		this.curItemInList = document.createElement("listitem");
		this.curItemInListId = document.createElement("listcell");
		this.curItemInListStatus = document.createElement("listcell");
		this.curItemInListContent = document.createElement("listcell");
		this.curItemInListId.setAttribute("label", strBundle.getString("unknown"));
		this.curItemInListStatus.setAttribute("label", strBundle.getString("parsing"));
		this.curItemInListContent.setAttribute("label", strBundle.getString("unknown"));
		

		this.curItemInList.appendChild(this.curItemInListId);
		this.curItemInList.appendChild(this.curItemInListStatus);
		this.curItemInList.appendChild(this.curItemInListContent);
		
		this.itemList.appendChild(this.curItemInList);
		
		
		// get the content in a nice format
		fileContent = stripMailHeader(fileContent);

		// parse the content
		var parsedEvent = message2Event(fileContent);
		
		if (parsedEvent == null)
		{
			this.curItemInListId.setAttribute("label", strBundle.getString("unparseable"));
			return null;
		}

		// remember current uid
		this.gCurUID = getUID(parsedEvent.id);

		// update list item
		this.curItemInListId.setAttribute("label", parsedEvent.id);
		this.curItemInListStatus.setAttribute("label", strBundle.getString("checking"));
		var info = parsedEvent.title + " (" +
		           date2String(parsedEvent.startDate.jsDate) + ")";
		this.curItemInListContent.setAttribute("label", info);
		
		// remember that we did this uid already
		this.folderMessageUids.push(parsedEvent.id);
		
		// ok lets see if we have this one already 
		var foundEvent = findEvent (this.gEvents, parsedEvent.id);
		
		// get the dbfile from the local disk
		var idxEntry = getSyncDbFile(this.gConfig, true, parsedEvent.id);
		
		// always add if the forceLocalCopy flag is set (happens when you change the configuration)
		if (foundEvent == null || this.forceLocalCopy)
		{
		    // a new event
		    logMessage("a new event, locally unknown:" + parsedEvent.id, LOG_CAL + LOG_DEBUG);
			if (!idxEntry.exists())
			{
				// use the original content to write the snyc file 
				// this makes it easier to compare later on and makes sure no info is 
				// lost/changed
				writeSyncDBFile (idxEntry, fileContent);
				
				this.curItemInListStatus.setAttribute("label", strBundle.getString("localAdd"));
				
    			// add the new event
    			this.gCalendar.addItem(parsedEvent, this.gEvents);

				logMessage("added locally:" + parsedEvent.id, LOG_CAL + LOG_INFO);
			}
			else
			{
				// now this should be deleted, since it was in the db already
				logMessage("Delete event on server and in db: " + parsedEvent.id, LOG_CAL + LOG_INFO);
				this.curItemInListStatus.setAttribute("label", strBundle.getString("deleteOnServer"));

				// also remove the local db file since we deleted the contact
				idxEntry.remove(false);
				
				return "DELETEME";
			}
		}
		else
		{
		    // event exists in local calendar
			logMessage("Event exists local: " + parsedEvent.id, LOG_CAL + LOG_DEBUG);
			
			var cEvent = message2Event(readSyncDBFile(idxEntry));
			
			var hasEntry = idxEntry.exists() && (cEvent != null);
			// make sure cEvent is not null, else the comparision will fail
			var equal2parsed = hasEntry && equalsEvent(cEvent, parsedEvent);
			var equal2found = hasEntry && equalsEvent(cEvent, foundEvent);

			if (hasEntry && !equal2parsed && !equal2found)
 			{
			    // changed locally and on server side
				logMessage("Changed on server and local: " + parsedEvent.id, LOG_CAL + LOG_DEBUG);
				
                // FIXME
                takeAlwaysFromServer = false;				
				if (takeAlwaysFromServer || 
				   (window.confirm("Changes were made on the server and local. Click ok to use the server version.\nClient Event: " + 
					foundEvent.title + "<"+ foundEvent.id + ">\nServer Event: " + parsedEvent.title + "<"+ parsedEvent.id + ">")))
 				{
 					// take event from server
					logMessage("Take event from server: " + parsedEvent.id, LOG_CAL + LOG_INFO);
					
					writeSyncDBFile (idxEntry, fileContent);
	
					for (var i = 0; i < this.gEvents.events.length; i++)
					{
						if (this.gEvents.events[i].id == parsedEvent.id)
						{
							try {
							    // modify the item - catch exceptions due to triggered alarms
							    // because they will break the sync process
								this.gCalendar.modifyItem(parsedEvent, foundEvent, this.gEvents);
							} catch (e) {}
							
							//update list item
							this.curItemInListStatus.setAttribute("label", strBundle.getString("localUpdate"));
							
							return null;
						}
					}
				}
				else
				{
					// local change to server
					logMessage ("put event on server: " + parsedEvent.id, LOG_CAL + LOG_INFO);
					
                    var msg = null;
                    if (this.format == "Xml")
                    {
                        msg = event2kolabXmlMsg(foundEvent, this.email);
                    } 
                    else
                    {
						icssrv = Components.classes["@mozilla.org/calendar/ics-service;1"]
							.getService(Components.interfaces.calIICSService);
						var calComp = icssrv.createIcalComponent("VCALENDAR");
						calComp.version = "2.0";
						calComp.prodid = "-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN";
						calComp.addSubcomponent(foundEvent.icalComponent);
						
						msg = generateMail(cur.id, this.email, "iCal", "text/calendar", 
							false, encodeQuoted(encode_utf8(calComp.serializeToICS())), null);
					}

					writeSyncDBFile (idxEntry, stripMailHeader(msg));

					// update list item
					this.curItemInListStatus.setAttribute("label", strBundle.getString("updateOnServer"));
					
					// remember this message for update
					return msg;
				}
			}
			else
			{
				logMessage("changed only on one side (if at all):" + parsedEvent.id, LOG_CAL + LOG_DEBUG);
				
				// we got that already, see which is newer and update the message or the event
				// the sync database might be out-of-date, so we handle a non-existent entry as well
				if (!hasEntry || (!equal2parsed && equal2found))
				{
					logMessage("event on server changed: " + parsedEvent.id, LOG_CAL + LOG_INFO);
					
					writeSyncDBFile (idxEntry, fileContent);
	
					for (var i = 0; i < this.gEvents.events.length; i++)
					{
						if (this.gEvents.events[i].id == parsedEvent.id)
						{
							try {
							    // modify the item - catch exceptions due to triggered alarms
							    // because they will break the sync process
 								this.gCalendar.modifyItem(parsedEvent, foundEvent, this.gEvents);
							} catch (e) {}
	
							// update list item
							this.curItemInListStatus.setAttribute("label", strBundle.getString("localUpdate"));
							 
							return null;
						}
					}
				}
				else
				if (equal2parsed && !equal2found)
				{
					logMessage("event on client changed: " + parsedEvent.id, LOG_CAL + LOG_INFO);
	
					var msg = null;
					if (this.format == "Xml")
					{
						msg = event2kolabXmlMsg(foundEvent, this.email);
					} 
					else
					{
						icssrv = Components.classes["@mozilla.org/calendar/ics-service;1"]
							.getService(Components.interfaces.calIICSService);
						var calComp = icssrv.createIcalComponent("VCALENDAR");
						calComp.version = "2.0";
						calComp.prodid = "-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN";
						calComp.addSubcomponent(foundEvent.icalComponent);
						
						msg = generateMail(parsedEvent.id, this.email, "iCal", "text/calendar", 
							false, encodeQuoted(encode_utf8(calComp.serializeToICS())), null);
					}
					
					// update list item
					this.curItemInListStatus.setAttribute("label", strBundle.getString("updateOnServer"));

					writeSyncDBFile (idxEntry, stripMailHeader(msg));
					
					// remember this message for update
					return msg;
				}
				
				logMessage("no change for event:" + parsedEvent.id, LOG_CAL + LOG_INFO);
				this.curItemInListStatus.setAttribute("label", strBundle.getString("noChange"));
			}
		}
		return null;
	},
	
	
	initUpdate: function () {
		this.gCurEvent = 0;
		this.gCurTodo = 0;
		return true;
	},
	
	/**
	 * read the next todo/event and return the content if update needed
	 */
	nextUpdate: function () {
		logMessage("next update...", LOG_CAL + LOG_DEBUG);
		// if there happens an exception, we are done
		if ((this.gEvents == null || this.gCurEvent >= this.gEvents.events.length) && (this.gTodo == null || this.gCurTodo >= this.gTodo.length))
		{
			logMessage("done update...", LOG_CAL + LOG_INFO);
			// we are done
			return "done";
		}
		logMessage("get event", LOG_CAL + LOG_DEBUG);
		
		if (this.gEvents != null && this.gCurEvent <= this.gEvents.events.length )
		{
			var cur = this.gEvents.events[this.gCurEvent++];
			var msg = null;
			var writeCur = true;
		    
			logMessage ("nextUpdate for event:" + cur.id, LOG_CAL + LOG_DEBUG);

			// check if we have this uid in the messages, skip it if it
			// has been processed already when reading the IMAP msgs
			var i;
			for (i = 0; i < this.folderMessageUids.length; i++)
			{
				if (cur.id == this.folderMessageUids[i])
				{
					logMessage("event is known from IMAP lookup: " + cur.id, LOG_CAL + LOG_INFO);
					writeCur = false;
					break;
				}
			}
			
			// ok we should have this event in our db but 
			// not on the imap acct. if we got this entry in our internal db
			// it has been deleted on the server and we dont know about it yet
			if (writeCur)
			{
				logMessage("nextUpdate decided to write event:" + cur.id, LOG_CAL + LOG_INFO);

				var cEntry = getSyncDbFile	(this.gConfig, true, cur.id);
				
				if (cEntry.exists() && !this.forceServerCopy)
				{
					// we have it in our database - don't write back to server but delete locally
					logMessage("nextUpdate assumes 'delete on server', better don't write event:" + cur.id, LOG_CAL + LOG_INFO);

					writeCur = false;
					this.gCalendar.deleteItem(cur, this.gEvents);
					
					// also remove the local db file since we deleted the contact on the server
					cEntry.remove(false);
					
					// create a new item in the itemList for display
					this.curItemInList = document.createElement("listitem");
					this.curItemInListId = document.createElement("listcell");
					this.curItemInListStatus = document.createElement("listcell");
					this.curItemInListContent = document.createElement("listcell");
					this.curItemInListId.setAttribute("label", cur.id);
					this.curItemInListStatus.setAttribute("label", strBundle.getString("localDelete"));
					this.curItemInListContent.setAttribute("label", cur.title);
					
			
					this.curItemInList.appendChild(this.curItemInListId);
					this.curItemInList.appendChild(this.curItemInListStatus);
					this.curItemInList.appendChild(this.curItemInListContent);
					
					this.itemList.appendChild(this.curItemInList);
					
				}
				else
				{
					// create a new item in the itemList for display
					this.curItemInList = document.createElement("listitem");
					this.curItemInListId = document.createElement("listcell");
					this.curItemInListStatus = document.createElement("listcell");
					this.curItemInListContent = document.createElement("listcell");
					this.curItemInListId.setAttribute("label", cur.id);
					this.curItemInListStatus.setAttribute("label", strBundle.getString("addToServer"));
					this.curItemInListContent.setAttribute("label", cur.title);
					
					this.curItemInList.appendChild(this.curItemInListId);
					this.curItemInList.appendChild(this.curItemInListStatus);
					this.curItemInList.appendChild(this.curItemInListContent);
					
					this.itemList.appendChild(this.curItemInList);
				}
			}

		
			if (writeCur)
			{
				logMessage("nextUpdate really writes event:" + cur.id, LOG_CAL + LOG_DEBUG);
				// and now really write the message
				
                var msg = null;
                if (this.format == "Xml")
                {
				    msg = event2kolabXmlMsg(cur, this.email);
                } 
                else
                {
    				icssrv = Components.classes["@mozilla.org/calendar/ics-service;1"]
    					.getService(Components.interfaces.calIICSService);
    				var calComp = icssrv.createIcalComponent("VCALENDAR");
    				calComp.version = "2.0";
    				calComp.prodid = "-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN";
    				calComp.addSubcomponent(cur.icalComponent);
    				
					msg = generateMail(cur.id, this.email, "iCal", "text/calendar", 
						false, encodeQuoted(encode_utf8(calComp.serializeToICS())), null);
					
				}
				
		    	logMessage("New event:\n" + msg, LOG_CAL + LOG_DEBUG);
				logMessage("nextUpdate puts event into db (2):" + cur.id, LOG_CAL + LOG_INFO);
				
				// add the new event into the db
				var cEntry = getSyncDbFile	(this.gConfig, true, cur.id);
				writeSyncDBFile (cEntry, stripMailHeader(msg));

			}
		}	
		else
		if (this.gTodo != null && this.gCurTodo <= this.gTodo.length)
		{
			var cur = this.gTodo[this.gCurTodo++];
			var msg = null;
	    	var writeCur = false;
		    
			writeCur = true;
			// check if we have this uid in the messages
			var i;
			for (i = 0; i < this.folderMessageUids.length; i++)
			{
				if (cur.id == this.folderMessageUids[i])
				{
					logMessage("we got this todo: " + cur.id, LOG_CAL + LOG_INFO);
					writeCur = false;
					break;
				}
			}
		
			if (writeCur)
			{
				// and write the message
				var msg = genMailHeader(cur.id, "iCal", "text/calendar", false);
				msg += encodeQuoted(encode_utf8(cur.getIcalString()));
				msg += "\n\n";s
				
				logMessage("New event [" + msg + "]", LOG_CAL + LOG_INFO);
			}
		}
		
		// return the event's content
		return msg;
	},
	
	
	doneParsing: function ()
	{
		writeDataBase (this.dbFile, this.db);
	}
}
