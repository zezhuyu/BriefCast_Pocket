//
//  ContentView.swift
//  BriefCast
//
//  Created by Zezhu Yu on 2025-06-09.
//

import SwiftUI
import UIKit

struct ContentView: View {
    @StateObject private var playerViewModel = PlayerViewModel()
    @State private var selectedTab = 0
    
    var body: some View {
        TabView(selection: $selectedTab) {
            PlayerView()
                .tabItem {
                    Image(systemName: "play.circle.fill")
                    Text("Player")
                }
                .tag(0)
                .environmentObject(playerViewModel)
            
            LibraryView()
                .tabItem {
                    Image(systemName: "books.vertical.fill")
                    Text("Library")
                }
                .tag(1)
                .environmentObject(playerViewModel)
            
            HistoryView()
                .tabItem {
                    Image(systemName: "clock.fill")
                    Text("History")
                }
                .tag(2)
                .environmentObject(playerViewModel)
            
            DownloadsView()
                .tabItem {
                    Image(systemName: "square.and.arrow.down.fill")
                    Text("Downloads")
                }
                .tag(3)
                .environmentObject(playerViewModel)
        }
        .accentColor(Color.accentColor)
        .onAppear {
            configureTabBarAppearance(for: selectedTab)
        }
        .onChange(of: selectedTab) { newTab in
            configureTabBarAppearance(for: newTab)
        }
        .onReceive(playerViewModel.$shouldNavigateToPlayer) { shouldNavigate in
            if shouldNavigate {
                selectedTab = 0 // Navigate to Player tab
                playerViewModel.shouldNavigateToPlayer = false // Reset flag
            }
        }
    }
    
    private func configureTabBarAppearance(for tab: Int) {
        let appearance = UITabBarAppearance()
        
        if tab == 0 {
            appearance.configureWithTransparentBackground()

            appearance.stackedLayoutAppearance.normal.iconColor = UIColor.white.withAlphaComponent(0.6)
            appearance.stackedLayoutAppearance.normal.titleTextAttributes = [
                .foregroundColor: UIColor.white.withAlphaComponent(0.6)
            ]
        } else {
            appearance.configureWithDefaultBackground()

            appearance.stackedLayoutAppearance.normal.iconColor = UIColor.gray.withAlphaComponent(0.6)
            appearance.stackedLayoutAppearance.normal.titleTextAttributes = [
                .foregroundColor: UIColor.gray.withAlphaComponent(0.6)
            ]
        }
        
        if let tabBar = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first?.windows
            .first(where: { $0.isKeyWindow })?
            .rootViewController?
            .children
            .compactMap({ $0 as? UITabBarController })
            .first?.tabBar {
            
            tabBar.standardAppearance = appearance
            if #available(iOS 15.0, *) {
                tabBar.scrollEdgeAppearance = appearance
            }
        }
    }
}

#Preview {
    ContentView()
}

